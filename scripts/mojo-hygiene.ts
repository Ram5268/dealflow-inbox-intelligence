// Brief 7.2 (Fix #8) — one-time, idempotent data-hygiene pass over MojoContact.
//
//   Phase A (SQL): drop leaked CSV header rows, null out city==address noise,
//                  null out malformed emails.
//   Phase B: backfill neighborhood for rows that have an address but no
//            neighborhood, via lib/mojo/geocode (Nominatim primary, Sonnet
//            fallback — hallucination-safe: still-unknown stays null).
//
// Safe to re-run. Hard-stops if Sonnet fallback spend would exceed $2.
//
// Run: npx tsx scripts/mojo-hygiene.ts
//  (or: npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/mojo-hygiene.ts)
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { geocodeAddress } from '../lib/mojo/geocode'

// Cheap Sonnet fallback (~$0.0003/call per the brief). Hard cap total spend.
const SONNET_COST_PER_CALL = 0.0003
const SPEND_CAP_USD = 2

async function neighborhoodCoverage() {
  const total = await prisma.mojoContact.count()
  const populated = await prisma.mojoContact.count({ where: { neighborhood: { not: null } } })
  return { total, populated, nullCount: total - populated }
}

async function main() {
  console.log('=== Mojo hygiene ===\n')

  const before = await neighborhoodCoverage()
  console.log('BEFORE:', before)

  // ── Phase A — SQL cleanup (idempotent) ─────────────────────────────────────
  const deletedHeaders = await prisma.$executeRawUnsafe(
    `DELETE FROM "MojoContact" WHERE "fullName" IN ('Full Name', 'Contact Name', 'Name', 'First Last')`,
  )
  const nulledCity = await prisma.$executeRawUnsafe(
    `UPDATE "MojoContact" SET city = NULL WHERE city = address`,
  )
  const nulledEmail = await prisma.$executeRawUnsafe(
    `UPDATE "MojoContact" SET email = NULL WHERE email IS NOT NULL AND email NOT LIKE '%@%.%'`,
  )
  console.log('\nPhase A (SQL cleanup):')
  console.log(`  header rows deleted:   ${deletedHeaders}`)
  console.log(`  city=address nulled:   ${nulledCity}`)
  console.log(`  bad emails nulled:     ${nulledEmail}`)

  // ── Phase B — neighborhood backfill ────────────────────────────────────────
  const targets = await prisma.mojoContact.findMany({
    where: { neighborhood: null, address: { not: null }, isTestData: false },
    select: { id: true, address: true },
  })
  console.log(`\nPhase B (neighborhood backfill): ${targets.length} rows to geocode`)

  let processed = 0
  let filled = 0
  let sonnetCalls = 0
  let stoppedForCost = false

  for (const row of targets) {
    if (sonnetCalls * SONNET_COST_PER_CALL >= SPEND_CAP_USD) {
      stoppedForCost = true
      console.log(`\n  !! Sonnet spend cap ($${SPEND_CAP_USD}) reached — stopping backfill early.`)
      break
    }

    const addr = `${row.address}, New York, NY`
    let result
    try {
      result = await geocodeAddress(addr)
    } catch (e) {
      console.warn(`  geocode failed for ${row.id}: ${(e as Error).message}`)
      processed++
      continue
    }
    if (result.source === 'sonnet') sonnetCalls++

    // May still be null (geocoder unsure) — leave null, never hallucinate.
    if (result.neighborhood) {
      await prisma.mojoContact.update({ where: { id: row.id }, data: { neighborhood: result.neighborhood } })
      filled++
    }

    processed++
    if (processed % 100 === 0) {
      console.log(`  ...${processed}/${targets.length} processed, ${filled} filled, ${sonnetCalls} Sonnet calls (~$${(sonnetCalls * SONNET_COST_PER_CALL).toFixed(4)})`)
    }
  }

  const after = await neighborhoodCoverage()

  console.log('\n=== Report ===')
  console.log('AFTER:', after)
  console.log(`Rows processed:        ${processed}`)
  console.log(`Neighborhoods filled:  ${filled}`)
  console.log(`Still null:            ${after.nullCount}`)
  console.log(`Sonnet fallback calls: ${sonnetCalls} (~$${(sonnetCalls * SONNET_COST_PER_CALL).toFixed(4)})`)
  if (stoppedForCost) console.log('NOTE: stopped early on the $2 Sonnet spend cap — re-run to continue.')
}

main()
  .catch(e => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())

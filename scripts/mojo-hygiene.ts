// Brief 7.2 (Fix #8) — one-time, idempotent data-hygiene pass over MojoContact.
//
//   Phase A (SQL): drop leaked CSV header rows, null out city==address noise,
//                  null out malformed emails.
//   Phase B: backfill neighborhood for rows that have an address but no
//            neighborhood, via lib/mojo/geocode (Nominatim primary, Sonnet
//            fallback — hallucination-safe: still-unknown stays null).
//
// Safe to re-run. Hard-stops if Sonnet fallback spend would exceed $2.
// A dry run (counts only: no change, no geocoding) unless --apply.
//
// Run: npx tsx scripts/mojo-hygiene.ts --apply
//  (or: npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/mojo-hygiene.ts --apply)
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { geocodeAddress } from '../lib/mojo/geocode'
import { maintenanceApply } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): it changes real contacts, so it's a dry
// run unless --apply, and --apply on a database that isn't *_perf / *_test also
// needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/mojo-hygiene.ts (DATABASE_URL)')

// Cheap Sonnet fallback (~$0.0003/call per the brief). Hard cap total spend.
const SONNET_COST_PER_CALL = 0.0003
const SPEND_CAP_USD = 2

// What Phase A deletes or blanks, and the rows Phase B geocodes (the dry run
// counts the same rows).
const HEADER_ROWS = `"fullName" IN ('Full Name', 'Contact Name', 'Name', 'First Last')`
const CITY_IS_ADDRESS = 'city = address'
const BAD_EMAIL = `email IS NOT NULL AND email NOT LIKE '%@%.%'`
const NEEDS_NEIGHBORHOOD = { neighborhood: null, address: { not: null }, isTestData: false }

async function neighborhoodCoverage() {
  const total = await prisma.mojoContact.count()
  const populated = await prisma.mojoContact.count({ where: { neighborhood: { not: null } } })
  return { total, populated, nullCount: total - populated }
}

async function main() {
  console.log('=== Mojo hygiene ===\n')

  const before = await neighborhoodCoverage()
  console.log('BEFORE:', before)

  if (!APPLY) {
    const count = async (where: string) =>
      (await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "MojoContact" WHERE ${where}`))[0].n
    console.log('\nDry run (nothing changed, nothing geocoded):')
    console.log(`  Phase A would delete ${await count(HEADER_ROWS)} header rows, blank ${await count(CITY_IS_ADDRESS)} city=address values and ${await count(BAD_EMAIL)} bad emails.`)
    console.log(`  Phase B would geocode ${await prisma.mojoContact.count({ where: NEEDS_NEIGHBORHOOD })} rows (Sonnet fallback capped at $${SPEND_CAP_USD}).`)
    console.log('Re-run with --apply to make these changes.')
    return
  }

  // ── Phase A — SQL cleanup (idempotent) ─────────────────────────────────────
  const deletedHeaders = await prisma.$executeRawUnsafe(
    `DELETE FROM "MojoContact" WHERE ${HEADER_ROWS}`,
  )
  const nulledCity = await prisma.$executeRawUnsafe(
    `UPDATE "MojoContact" SET city = NULL WHERE ${CITY_IS_ADDRESS}`,
  )
  const nulledEmail = await prisma.$executeRawUnsafe(
    `UPDATE "MojoContact" SET email = NULL WHERE ${BAD_EMAIL}`,
  )
  console.log('\nPhase A (SQL cleanup):')
  console.log(`  header rows deleted:   ${deletedHeaders}`)
  console.log(`  city=address nulled:   ${nulledCity}`)
  console.log(`  bad emails nulled:     ${nulledEmail}`)

  // ── Phase B — neighborhood backfill ────────────────────────────────────────
  const targets = await prisma.mojoContact.findMany({
    where: NEEDS_NEIGHBORHOOD,
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

// Phase 4.6.3 (prep) — Step 4 audit + Step 6 cohort/snapshot/invalidate.
// Builds the combined re-backfill cohort, snapshots it BEFORE any write, then
// invalidates the affected cache keys. Opportunity rows are NOT touched here.
//
//   npx tsx scripts/step463-prep.ts
import 'dotenv/config'
import { writeFileSync } from 'fs'
import { prisma } from '../lib/prisma'
import { normalizeAddress } from '../lib/domain/Address'
import { stripBareUnitSuffix } from '../lib/enrichment/nyc' // NEW strip (Phase 4.6.3)
import { refuseLiveDatabase } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): a finished one-off (Phase 4.6.3) that
// deletes cache rows, so it refuses any database but a *_perf or *_test one,
// with no override.
refuseLiveDatabase(process.env.DATABASE_URL, 'scripts/step463-prep.ts (DATABASE_URL)')

// OLD strip (Phase 4.6.2, pre-4.6.3) — to detect rows the new patterns now change.
function oldStrip(addr: string): string {
  if (!addr) return addr
  return addr
    .replace(/^\s*(?:apt|apartment|unit|#)\s*[\w-]+\s*,\s*/i, '')
    .replace(/,?\s+(?:apt|apartment|unit|#)\s*[\w-]+\s*$/i, '')
    .replace(/,?\s+(?:floor|flr|fl)\.?\s*\d+[a-z]?\s*$/i, '')
    .replace(/,?\s+(?:studio|penthouse|loft)(?:\s+\d+[a-z]?)?\s*$/i, '')
    .replace(/[,\s]+\d{1,3}[a-z]?\/\d{1,3}[a-z]?\s*$/i, '')
    .replace(/\b(street|avenue|ave|st|road|rd|boulevard|blvd|place|pl|drive|dr|way|lane|ln|terrace|court|ct|parkway|pkwy)\.?\s+(\d{1,3}[a-z]|ph[0-9a-z]?|[a-z]\d{1,2})\s*$/i, '$1')
    .replace(/,\s*(\d{1,3}[a-z]|ph[0-9a-z]?|[a-z]\d{1,2})\s*$/i, '')
    .trim()
}
const PLACEHOLDER_SUBSTRINGS = [/\btbd\b/i, /\btba\b/i, /\bvarious\b/i, /\bcoming soon\b/i, /\bcall for (?:address|details)\b/i, /\baddress upon request\b/i, /\bmultiple addresses?\b/i]
const isPlaceholder = (a: string) => PLACEHOLDER_SUBSTRINGS.some(re => re.test(a))
const hasFraction = (a: string) => /\b\d+\s+\d\/\d\b/.test(a)

async function main() {
  const opps = await prisma.extractedOpportunity.findMany({
    select: { id: true, address: true, propertyType: true, propertyTypeReason: true },
  })

  // Step 4 — TBD/landmark audit: placeholder-substring address that RESOLVED to a real type.
  const tbd = opps.filter(o => o.address && isPlaceholder(o.address) && o.propertyType != null && /^(pluto_class=|cached:pluto_class=)/.test(o.propertyTypeReason ?? ''))
  console.log(`\n[Step 4] TBD/landmark over-resolutions (placeholder addr → confident type): ${tbd.length}`)
  for (const t of tbd.slice(0, 20)) console.log(`  ${t.id}  "${t.address}"  → ${t.propertyType} (${t.propertyTypeReason})`)
  if (tbd.length > 20) console.log(`  … and ${tbd.length - 20} more`)
  if (tbd.length > 20) console.log(`  ⚠️ >20 TBD rows — higher than expected (decision tree: planner should look).`)

  // Step 6a — strip-gap cohort: currently NULL, and the NEW strip changes the address vs the OLD strip.
  const stripGap = opps.filter(o => o.address && o.propertyType == null && oldStrip(o.address).trim() !== stripBareUnitSuffix(o.address).trim())
  console.log(`\n[Step 6] strip-gap cohort (null + new strip differs from old): ${stripGap.length}`)
  for (const s of stripGap.slice(0, 20)) console.log(`  "${s.address}"  old="${oldStrip(s.address!)}"  new="${stripBareUnitSuffix(s.address!)}"`)

  // Step 6b — fractional cohort: currently NULL with a fractional address (top-5+fraction geocode may now resolve).
  const fractional = opps.filter(o => o.address && o.propertyType == null && hasFraction(o.address))
  console.log(`\n[Step 6] fractional cohort (null + fraction in address): ${fractional.length}`)
  for (const f of fractional.slice(0, 20)) console.log(`  ${f.id}  "${f.address}"  (${f.propertyTypeReason})`)

  // Combine + dedupe.
  const byId = new Map<string, { id: string; address: string | null; propertyType: string | null; propertyTypeReason: string | null }>()
  for (const o of [...tbd, ...stripGap, ...fractional]) byId.set(o.id, o)
  const cohort = [...byId.values()]
  console.log(`\nCombined cohort (deduped): ${cohort.length}  (tbd=${tbd.length}, stripGap=${stripGap.length}, fractional=${fractional.length})`)

  // Snapshot BEFORE any write.
  writeFileSync('scripts/cohort-4-6-3-pre-snapshot.json', JSON.stringify(cohort, null, 2))
  writeFileSync('scripts/cohort-4-6-3-ids.txt', cohort.map(c => c.id).join(','))
  console.log(`✅ snapshot written: ${cohort.length} rows → scripts/cohort-4-6-3-pre-snapshot.json`)

  // Invalidate cache: old + new normalized keys for the cohort.
  const keys = new Set<string>()
  for (const o of cohort) {
    const oldK = normalizeAddress(oldStrip(o.address ?? ''))?.normalized
    const newK = normalizeAddress(stripBareUnitSuffix(o.address ?? ''))?.normalized
    const rawK = normalizeAddress(o.address ?? '')?.normalized
    if (oldK) keys.add(oldK); if (newK) keys.add(newK); if (rawK) keys.add(rawK)
  }
  const before = await prisma.nycParcelCache.count()
  const del = await prisma.nycParcelCache.deleteMany({ where: { normalizedAddress: { in: [...keys] } } })
  console.log(`✅ cache invalidated: ${del.count} rows deleted (${[...keys].length} keys) — cache ${before} → ${before - del.count}`)

  await prisma.$disconnect()
}
main().catch(async e => { console.error('FATAL:', e); await prisma.$disconnect().catch(() => {}); process.exit(1) })

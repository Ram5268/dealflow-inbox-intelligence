// Phase 4.6.2 Step 4 (stage 1) — snapshot the 508 cohort-A rows BEFORE any write,
// then invalidate their stale cache entries (old + new normalized keys) plus the
// explicit 7 W 96th stale-label rows. Opportunity rows are NOT touched here; the
// re-backfill (stage 2) updates them. The snapshot is the hand-revert mechanism.
import 'dotenv/config'
import { readFileSync, writeFileSync } from 'fs'
import { prisma } from '../lib/prisma'
import { normalizeAddress } from '../lib/domain/Address'
import { stripBareUnitSuffix } from '../lib/enrichment/nyc'
import { refuseLiveDatabase } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): a finished one-off (Phase 4.6.2) that
// deletes cache rows, so it refuses any database but a *_perf or *_test one,
// with no override.
refuseLiveDatabase(process.env.DATABASE_URL, 'scripts/step4-snapshot-and-invalidate.ts (DATABASE_URL)')

interface CohortRow { oppId: string; originalAddress: string | null; currentBbl: string | null; currentLabel: string | null; borough: string | null }

async function main() {
  const cohort: CohortRow[] = JSON.parse(readFileSync('scripts/cohort-A-misgeocoded.json', 'utf8'))
  const ids = [...new Set(cohort.map(c => c.oppId))]
  console.log(`Cohort A opps: ${cohort.length} (${ids.length} unique ids)`)

  // ── Guard 1: snapshot current opp state BEFORE any DB write ──
  const opps = await prisma.extractedOpportunity.findMany({
    where: { id: { in: ids } },
    select: { id: true, address: true, borough: true, propertyType: true, propertyTypeReason: true },
  })
  const cohortByOpp = new Map(cohort.map(c => [c.oppId, c]))
  const snapshot = opps.map(o => ({
    id: o.id,
    address: o.address,
    propertyType: o.propertyType,
    propertyTypeReason: o.propertyTypeReason,
    cacheBbl: cohortByOpp.get(o.id)?.currentBbl ?? null,
    cacheLabel: cohortByOpp.get(o.id)?.currentLabel ?? null,
  }))
  writeFileSync('scripts/cohort-A-pre-step4-snapshot.json', JSON.stringify(snapshot, null, 2))
  writeFileSync('scripts/cohort-A-ids.txt', ids.join(','))
  console.log(`✅ snapshot written: ${snapshot.length} rows → scripts/cohort-A-pre-step4-snapshot.json`)
  const preNullCount = snapshot.filter(s => s.propertyType == null).length
  console.log(`   pre-state: ${snapshot.length - preNullCount} have a propertyType, ${preNullCount} null`)

  // ── Cache invalidation: delete cache rows under BOTH the old (unit-polluted)
  //    and new (stripped) normalized keys for the 508, so the re-backfill resolves
  //    fresh under the corrected key. Plus the explicit 7 W 96th stale-label rows. ──
  const keys = new Set<string>()
  for (const o of opps) {
    const oldNorm = normalizeAddress(o.address)?.normalized
    const newNorm = normalizeAddress(stripBareUnitSuffix(o.address ?? ''))?.normalized
    if (oldNorm) keys.add(oldNorm)
    if (newNorm) keys.add(newNorm)
  }
  const keyList = [...keys]
  console.log(`\nCache keys to invalidate: ${keyList.length} (old+new normalized forms)`)

  const before = await prisma.nycParcelCache.count()
  const del = await prisma.nycParcelCache.deleteMany({
    where: { OR: [{ normalizedAddress: { in: keyList } }, { normalizedAddress: { startsWith: '7 west 96' } }] },
  })
  const after = await prisma.nycParcelCache.count()
  console.log(`✅ cache rows deleted: ${del.count}  (cache ${before} → ${after})`)

  await prisma.$disconnect()
}
main().catch(async e => { console.error('FATAL:', e); await prisma.$disconnect().catch(() => {}); process.exit(1) })

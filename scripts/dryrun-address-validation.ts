// Phase 4.6.2 Step 2 — empirical dry-run of the Step-1 validators against real data.
// READ-ONLY: no DB writes, no cache writes (geocodeAddress is side-effect free).
//
// Cohort A = currently-misgeocoded opps (cache's matched street # incompatible with
//            the input's — the 363-building bug, expanded to opp level).
// Cohort B = ~100 known-good opps (real pluto_class resolution, not in A), spread
//            across boroughs.
// For each, run the NEW logic (stripBareUnitSuffix → geocodeAddress with the
// number-mismatch guard) and compare the new BBL to the BBL currently in cache.
//
//   npx tsx scripts/dryrun-address-validation.ts
import 'dotenv/config'
import { writeFileSync } from 'fs'
import PQueue from 'p-queue'
import { prisma } from '../lib/prisma'
import { normalizeAddress } from '../lib/domain/Address'
import { stripBareUnitSuffix, geocodeAddress, firstStreetNumber, streetNumbersCompatible } from '../lib/enrichment/nyc'

// ── Borough logic replicated from resolvePropertyType (keep query construction faithful) ──
const BOROUGH_CANONICAL: Record<string, string> = {
  manhattan: 'manhattan', mn: 'manhattan',
  brooklyn: 'brooklyn', kings: 'brooklyn', bk: 'brooklyn', bklyn: 'brooklyn',
  queens: 'queens', qn: 'queens', qns: 'queens',
  bronx: 'bronx', 'the bronx': 'bronx', bx: 'bronx',
  'staten island': 'staten island', richmond: 'staten island', si: 'staten island',
}
const GENERIC_NYC = new Set(['new york', 'new york city', 'nyc', 'ny', 'n.y.', 'n.y.c.'])
const boroughForCrossCheck = (raw: string) => BOROUGH_CANONICAL[raw.trim().toLowerCase()] ?? null
const isNycBorough = (raw: string) => { const s = raw.trim().toLowerCase(); return !!BOROUGH_CANONICAL[s] || GENERIC_NYC.has(s) }
const titleCase = (s: string) => s.replace(/\b\w/g, c => c.toUpperCase())

// Re-resolve an opp's BBL under the NEW logic (mirrors resolvePropertyType up to geocode).
async function newResolve(address: string | null, boroughRaw: string | null): Promise<{ bbl: string | null; reject: string | null; label: string | null }> {
  const cleaned = stripBareUnitSuffix((address ?? '').trim())
  const norm = normalizeAddress(cleaned)
  if (!norm || !norm.streetNumber) return { bbl: null, reject: 'no_street_number', label: null }
  const cross = boroughForCrossCheck(boroughRaw ?? '')
  const hint = cross ?? (isNycBorough(boroughRaw ?? '') ? boroughRaw : null)
  const street = norm.streetName ? `${norm.streetNumber} ${norm.streetName}` : cleaned
  const query = `${street}, ${hint ? titleCase(hint) : 'New York'}, NY`
  const geo = await geocodeAddress(query, cross)
  return { bbl: geo.bbl, reject: geo.rejectReason, label: geo.label }
}

interface OppLite { id: string; address: string | null; borough: string | null; propertyType: string | null; propertyTypeReason: string | null }
interface CohortRow { oppId: string; originalAddress: string | null; currentBbl: string | null; currentLabel: string | null; borough: string | null }

function classify(currentBbl: string | null, n: { bbl: string | null; reject: string | null }): string {
  if (n.bbl === null) return `new_logic_rejected:${n.reject ?? 'unknown'}`
  if (n.bbl === currentBbl) return 'unchanged_resolved'
  return 'changed_resolved_to_new_bbl'
}

async function main() {
  // 1. Load cache (old resolutions) keyed by normalized address.
  const cache = await prisma.nycParcelCache.findMany({
    select: { normalizedAddress: true, bbl: true, geosearchLabel: true },
  })
  const cacheByNorm = new Map(cache.map(c => [c.normalizedAddress, c]))
  const isMisgeocoded = (norm: string, label: string | null, bbl: string | null) => {
    if (!bbl || !label) return false
    const a = firstStreetNumber(norm), b = firstStreetNumber(label)
    return !!a && !!b && !streetNumbersCompatible(a, b)
  }

  // 2. Load all opps, attach their current (old) resolution via the OLD normalized key.
  const opps: OppLite[] = await prisma.extractedOpportunity.findMany({
    select: { id: true, address: true, borough: true, propertyType: true, propertyTypeReason: true },
  })

  const cohortA: CohortRow[] = []
  const goodPool: (CohortRow & { reason: string })[] = []
  for (const o of opps) {
    const oldNorm = normalizeAddress(o.address)?.normalized
    if (!oldNorm) continue
    const c = cacheByNorm.get(oldNorm)
    if (!c) continue
    if (isMisgeocoded(oldNorm, c.geosearchLabel, c.bbl)) {
      cohortA.push({ oppId: o.id, originalAddress: o.address, currentBbl: c.bbl, currentLabel: c.geosearchLabel, borough: o.borough })
    } else if (
      o.propertyType != null &&
      o.propertyTypeReason && /^pluto_class=/.test(o.propertyTypeReason) && // real PLUTO, not cached:/unknown
      !o.propertyTypeReason.includes('unknown_class') &&
      c.bbl
    ) {
      goodPool.push({ oppId: o.id, originalAddress: o.address, currentBbl: c.bbl, currentLabel: c.geosearchLabel, borough: o.borough, reason: o.propertyTypeReason })
    }
  }

  // 3. Cohort B — ~100 known-good, spread across the 4 main boroughs (deterministic stride sample).
  const byBoro: Record<string, (CohortRow & { reason: string })[]> = { manhattan: [], brooklyn: [], bronx: [], queens: [] }
  for (const g of goodPool) {
    const fromBorough = boroughForCrossCheck(g.borough ?? '')
    const lbl = (g.currentLabel ?? '').toLowerCase()
    const key = fromBorough ?? (lbl.includes('brooklyn') ? 'brooklyn' : lbl.includes('bronx') ? 'bronx' : lbl.includes('queens') ? 'queens' : 'manhattan')
    if (byBoro[key]) byBoro[key].push(g)
  }
  const cohortB: (CohortRow & { reason: string })[] = []
  for (const k of Object.keys(byBoro)) {
    const arr = byBoro[k]
    const take = Math.min(25, arr.length)
    if (take === 0) continue
    const stride = Math.max(1, Math.floor(arr.length / take))
    for (let i = 0, picked = 0; i < arr.length && picked < take; i += stride, picked++) cohortB.push(arr[i])
  }

  console.log(`Cohort A (misgeocoded opps): ${cohortA.length}`)
  console.log(`Cohort B (known-good sample): ${cohortB.length}  [pool ${goodPool.length}]`)

  writeFileSync('scripts/cohort-A-misgeocoded.json', JSON.stringify(cohortA, null, 2))
  writeFileSync('scripts/cohort-B-knowngood.json', JSON.stringify(cohortB.map(({ reason, ...r }) => r), null, 2))

  // 4. Dry-run both cohorts through the NEW logic.
  const queue = new PQueue({ concurrency: 4 })
  const aOutcomes: { row: CohortRow; outcome: string; newBbl: string | null; newLabel: string | null }[] = []
  const bOutcomes: { row: CohortRow & { reason: string }; outcome: string; newBbl: string | null; newLabel: string | null }[] = []

  await queue.addAll(cohortA.map(row => async () => {
    const n = await newResolve(row.originalAddress, row.borough)
    aOutcomes.push({ row, outcome: classify(row.currentBbl, n), newBbl: n.bbl, newLabel: n.label })
  }))
  await queue.addAll(cohortB.map(row => async () => {
    const n = await newResolve(row.originalAddress, row.borough)
    bOutcomes.push({ row, outcome: classify(row.currentBbl, n), newBbl: n.bbl, newLabel: n.label })
  }))

  // 5. Matrix.
  const tally = (rows: { outcome: string }[]) => {
    const t: Record<string, number> = {}
    for (const r of rows) {
      const key = r.outcome.startsWith('new_logic_rejected') ? r.outcome : r.outcome
      t[key] = (t[key] ?? 0) + 1
    }
    return t
  }
  const aT = tally(aOutcomes), bT = tally(bOutcomes)
  const sum = (t: Record<string, number>, pred: (k: string) => boolean) => Object.entries(t).filter(([k]) => pred(k)).reduce((s, [, v]) => s + v, 0)

  const aUnchanged = aT['unchanged_resolved'] ?? 0
  const aChanged = aT['changed_resolved_to_new_bbl'] ?? 0
  const aRejected = sum(aT, k => k.startsWith('new_logic_rejected'))
  const bUnchanged = bT['unchanged_resolved'] ?? 0
  const bChanged = bT['changed_resolved_to_new_bbl'] ?? 0
  const bRejected = sum(bT, k => k.startsWith('new_logic_rejected'))

  console.log('\n══════════════════ 2×2 OUTCOME MATRIX ══════════════════')
  console.log('                          | Cohort A (bad: ' + cohortA.length + ') | Cohort B (good: ' + cohortB.length + ')')
  console.log('  unchanged_resolved      | ' + String(aUnchanged).padStart(6) + ' (residual)   | ' + String(bUnchanged).padStart(6) + ' (preserved)')
  console.log('  changed_resolved_to_new | ' + String(aChanged).padStart(6) + ' (fixed?)     | ' + String(bChanged).padStart(6) + ' (verify)')
  console.log('  new_logic_rejected      | ' + String(aRejected).padStart(6) + ' (honest)     | ' + String(bRejected).padStart(6) + ' (FALSE POS)')
  console.log('  Cohort A reject breakdown:', JSON.stringify(Object.fromEntries(Object.entries(aT).filter(([k]) => k.startsWith('new_logic_rejected')))))
  console.log('  Cohort B reject breakdown:', JSON.stringify(Object.fromEntries(Object.entries(bT).filter(([k]) => k.startsWith('new_logic_rejected')))))

  const aFixed = aChanged + aRejected
  const aFixPct = cohortA.length ? (aFixed / cohortA.length * 100).toFixed(1) : 'n/a'
  console.log(`\n  Cohort A fixed (changed OR rejected): ${aFixed}/${cohortA.length} = ${aFixPct}%  (target ≥95%)`)
  console.log(`  Cohort B false positives (rejected):  ${bRejected}/${cohortB.length}  (target ≤2)`)

  // 6. Residual analysis — Cohort A still unchanged (fix didn't catch).
  console.log('\n── Cohort A RESIDUAL (unchanged_resolved — fix did NOT catch) ──')
  const aResidual = aOutcomes.filter(o => o.outcome === 'unchanged_resolved')
  for (const r of aResidual.slice(0, 40)) {
    const inN = firstStreetNumber(normalizeAddress(stripBareUnitSuffix(r.row.originalAddress ?? ''))?.normalized ?? '')
    const lblN = firstStreetNumber(r.row.currentLabel ?? '')
    console.log(`  "${r.row.originalAddress}"  →  "${r.row.currentLabel}"  (in#=${inN} lbl#=${lblN})`)
  }
  if (aResidual.length > 40) console.log(`  … and ${aResidual.length - 40} more`)

  // 7. False-positive + changed analysis — Cohort B rejected or changed.
  console.log('\n── Cohort B rejected (FALSE POSITIVES 🚨) ──')
  for (const r of bOutcomes.filter(o => o.outcome.startsWith('new_logic_rejected'))) {
    console.log(`  [${r.outcome}] "${r.row.originalAddress}"  (was bbl=${r.row.currentBbl} "${r.row.currentLabel}")`)
  }
  console.log('\n── Cohort B changed_resolved_to_new_bbl (needs spot-check) ──')
  for (const r of bOutcomes.filter(o => o.outcome === 'changed_resolved_to_new_bbl')) {
    console.log(`  "${r.row.originalAddress}"  was bbl=${r.row.currentBbl} → new bbl=${r.newBbl} "${r.newLabel}"`)
  }

  console.log('\n── Cohort A changed_resolved_to_new_bbl sample (verify these are the RIGHT building) ──')
  for (const r of aOutcomes.filter(o => o.outcome === 'changed_resolved_to_new_bbl').slice(0, 12)) {
    console.log(`  "${r.row.originalAddress}"  was "${r.row.currentLabel}" → new "${r.newLabel}" (bbl ${r.newBbl})`)
  }

  await prisma.$disconnect()
}
main().catch(async e => { console.error('FATAL:', e); await prisma.$disconnect().catch(() => {}); process.exit(1) })

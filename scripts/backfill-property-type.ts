// Phase 4.6 — Backfill propertyType + propertyTypeReason for existing
// ExtractedOpportunity rows using NYC public-data enrichment
// (GeoSearch → PLUTO → optional ACRIS).
//
// Default cohort: rows where propertyTypeReason IS NULL (i.e. never enriched).
// Concurrency 4 (each row makes up to 3 API calls). Idempotent + re-runnable —
// the NycParcelCache means repeated buildings cost one lookup, not many.
//
// NOTE: this updates the two columns only; it does NOT re-embed. Existing
// vectors keep their old propertyType until the row is re-ingested. (New V2
// ingestions enrich BEFORE embedding, so only the historical backfill is stale.)
//
// METRIC THAT MATTERS (Phase 4.6 backfill brief): not the total null rate (which
// lumps in EXPECTED outside-NYC/demand-side skips), but the NYC-BEARING success
// rate — of the rows we actually attempted to resolve via NYC public data, how
// many got a propertyType. Honest skips (outside-NYC, demand-side, no/placeholder
// address) are excluded from that denominator; they are correct, not failures.
// In-script hard stops abort the run if the NYC-bearing FAILURE rate is too high.
//
// Usage:
//   npx tsx scripts/backfill-property-type.ts [--limit N] [--category CAT] [--dry-run] [--ids id1,id2] [--all]
import 'dotenv/config'
import PQueue from 'p-queue'
import { prisma } from '../lib/prisma'
import { resolvePropertyType } from '../lib/enrichment/nyc'

// ── Arg parsing (space-separated, matching reprocess-v2-extraction.ts) ─────────
const argv = process.argv.slice(2)
function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const LIMIT    = flagValue('--limit') ? parseInt(flagValue('--limit')!, 10) : undefined
const CATEGORY = flagValue('--category')
const DRY_RUN  = argv.includes('--dry-run')
const ALL      = argv.includes('--all')
const IDS      = flagValue('--ids')?.split(',').map(s => s.trim()).filter(Boolean)
// Phase 4.6.1 — re-evaluate NYC-bearing nulls (unknown_class / ancillary /
// transient) against an updated class map. Stale "null + has bldgclass" cache
// rows are dropped first so the classifier re-runs with the new mapping.
const RECLASSIFY = argv.includes('--reclassify-unknown')
const CONCURRENCY = 4

interface OppRow {
  id:             string
  organizationId: string
  category:       string
  address:        string | null
  state:          string | null
  borough:        string | null
  neighborhood:   string | null
  propertyTypes:  string[]
  propertyType:   string | null   // pre-backfill value, for the correction diff
}

async function buildCohort(): Promise<OppRow[]> {
  const where: Record<string, unknown> = {}
  if (IDS && IDS.length) {
    where.id = { in: IDS }
  } else if (RECLASSIFY) {
    // NYC-bearing nulls only: exclude honest skips + definitive geocode/PLUTO
    // failures (those can't be fixed by a class-map change). Leaves the
    // unknown_class / ancillary / transient rows for re-classification.
    where.AND = [
      { propertyType: null },
      { propertyTypeReason: { not: { startsWith: 'skipped:' } } },
      { propertyTypeReason: { not: { startsWith: 'geosearch_failed' } } },
      { propertyTypeReason: { not: { startsWith: 'pluto_no_record' } } },
    ]
  } else if (!ALL) {
    where.propertyTypeReason = null // default: only un-enriched rows
  }
  if (CATEGORY) where.category = CATEGORY

  return prisma.extractedOpportunity.findMany({
    where,
    select: {
      id: true, organizationId: true, category: true, address: true,
      state: true, borough: true, neighborhood: true, propertyTypes: true,
      propertyType: true,
    },
    orderBy: { createdAt: 'desc' },
    ...(LIMIT != null ? { take: LIMIT } : {}),
  })
}

// Bucket a reason for the distribution. skipped:* and geosearch_failed:* keep two
// segments (so skipped:outside_nyc ≠ skipped:demand_or_non_property_category, and
// geosearch_failed:no_results ≠ :low_confidence). cached:* collapses to "cached".
// Everything else uses the first token before : = or +  (e.g. pluto_class).
function reasonPrefix(reason: string): string {
  if (reason.startsWith('skipped:') || reason.startsWith('geosearch_failed:')) {
    return reason.split(':').slice(0, 2).join(':')
  }
  if (reason.startsWith('cached:')) return 'cached'
  return reason.split(/[:=+]/)[0] || '(empty)'
}

// Honest skips — rows the system correctly declined to look up. EXCLUDED from the
// NYC-bearing cohort (they are expected nulls, not enrichment failures).
const HONEST_SKIP_PREFIXES = [
  'skipped:demand_or_non_property_category',
  'skipped:outside_nyc',
  'skipped:no_address',
  'skipped:placeholder_address',
  'skipped:no_street_number',
]
function isHonestSkip(reason: string): boolean {
  return HONEST_SKIP_PREFIXES.some(p => reason === p || reason.startsWith(p + ':'))
}

// Genuine NYC-pipeline failures (null result we DID try to resolve). Includes the
// transient *_unreachable reasons added in the review pass — a network failure is
// a non-resolution, and a spike in them signals Socrata/GeoSearch degradation.
const FAILURE_PREFIXES = [
  'geosearch_failed', 'geosearch_unreachable',
  'pluto_no_record', 'pluto_unreachable',
  'air_rights_lot',
]
function isNycFailure(reason: string): boolean {
  return FAILURE_PREFIXES.some(p => reason === p || reason.startsWith(p + ':'))
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('Phase 4.6 — propertyType backfill (NYC public-data enrichment)')
  console.log(`  flags: limit=${LIMIT ?? 'all'} category=${CATEGORY ?? 'any'} all=${ALL} reclassify=${RECLASSIFY} dryRun=${DRY_RUN} ids=${IDS?.length ?? 0}`)
  console.log('═══════════════════════════════════════════════════════════════════')

  const cohort = await buildCohort()
  const cohortLabel = IDS ? '' : RECLASSIFY ? '(NYC-bearing nulls — reclassify)' : ALL ? '' : '(propertyTypeReason IS NULL)'
  console.log(`\nCohort: ${cohort.length} opportunity row(s) ${cohortLabel}.\n`)
  if (cohort.length === 0) { await prisma.$disconnect(); return }

  if (DRY_RUN) {
    const byCat: Record<string, number> = {}
    for (const o of cohort) byCat[o.category] = (byCat[o.category] ?? 0) + 1
    for (const o of cohort.slice(0, 20)) {
      console.log(`  • ${o.id}  [${o.category}]  addr=${o.address ?? '∅'}  borough=${o.borough ?? '∅'}  state=${o.state ?? '∅'}`)
    }
    if (cohort.length > 20) console.log(`  … and ${cohort.length - 20} more`)
    console.log(`\n  categoryBreakdown: ${JSON.stringify(byCat)}`)
    console.log('\n  DRY RUN — no enrichment performed.')
    await prisma.$disconnect()
    return
  }

  // Phase 4.6.1 — drop stale "resolved to null but PLUTO gave us a bldgclass"
  // cache rows so the re-run re-classifies them with the updated map. Rows with
  // a real type, or null-with-no-bldgclass (geocode/PLUTO failures), are kept —
  // the dedup layer stays intact for everything the map change can't affect.
  if (RECLASSIFY) {
    const del = await prisma.nycParcelCache.deleteMany({ where: { propertyType: null, bldgclass: { not: null } } })
    console.log(`[reclassify] cleared ${del.count} stale null-classification cache rows (bldgclass present, type null)\n`)
  }

  const queue = new PQueue({ concurrency: CONCURRENCY })
  let processed = 0, updated = 0, errored = 0
  const typeDist: Record<string, number> = {}
  const prefixDist: Record<string, number> = {}
  const fullReasonDist: Record<string, number> = {}

  // NYC-bearing running tallies (read live by the hard-stop checker + progress).
  let nycResolved = 0, nycFailed = 0, acrisUnreachable = 0
  const nycFailSub: Record<string, number> = {}
  const failingAddrs: { id: string; address: string | null; reason: string }[] = []
  // Pre/post correction tracking (impact measurement) + a reservoir spot-check.
  let correctionsCount = 0
  const correctionSample: { id: string; address: string | null; before: string | null; after: string | null }[] = []
  const spotCheck: { id: string; address: string | null; type: string | null; reason: string }[] = []
  let resolvedSeen = 0
  let aborted = false
  let abortReason = ''

  // Hard stops (NYC-bearing failure rate). Returns an abort reason or null.
  // Gated on a minimum sample so early noise can't trip the rate checks.
  function checkHardStops(): string | null {
    if (errored > 5) return `uncaught errors > 5 (${errored})`
    const tries = nycResolved + nycFailed
    if (tries < 200) return null
    const rate = nycFailed / tries
    const sub = (k: string) => (nycFailSub[k] ?? 0) / tries
    if (sub('geosearch_failed:no_results') > 0.02) return `geosearch_failed:no_results ${(sub('geosearch_failed:no_results') * 100).toFixed(2)}% > 2% of NYC-bearing`
    if (sub('geosearch_failed:low_confidence') > 0.01) return `geosearch_failed:low_confidence ${(sub('geosearch_failed:low_confidence') * 100).toFixed(2)}% > 1% of NYC-bearing`
    if (sub('pluto_no_record') > 0.01) return `pluto_no_record ${(sub('pluto_no_record') * 100).toFixed(2)}% > 1% of NYC-bearing (geocoder returning bad BBLs?)`
    if (acrisUnreachable / tries > 0.005) return `acris_unreachable ${((acrisUnreachable / tries) * 100).toFixed(2)}% > 0.5% (Socrata degraded — pause + resume later)`
    if (tries >= 2500 && rate > 0.02) return `NYC-bearing failure rate ${(rate * 100).toFixed(2)}% > 2% at ${tries} tries`
    if (tries >= 1000 && rate > 0.03) return `NYC-bearing failure rate ${(rate * 100).toFixed(2)}% > 3% at ${tries} tries`
    if (rate > 0.04) return `NYC-bearing failure rate ${(rate * 100).toFixed(2)}% > 4%`
    return null
  }

  function tally(o: OppRow, type: string | null, reason: string) {
    typeDist[type ?? '(null)'] = (typeDist[type ?? '(null)'] ?? 0) + 1
    prefixDist[reasonPrefix(reason)] = (prefixDist[reasonPrefix(reason)] ?? 0) + 1
    fullReasonDist[reason] = (fullReasonDist[reason] ?? 0) + 1
    if (reason.includes('+acris_unreachable')) acrisUnreachable++

    if (!isHonestSkip(reason)) {
      if (isNycFailure(reason)) {
        nycFailed++
        nycFailSub[reasonPrefix(reason)] = (nycFailSub[reasonPrefix(reason)] ?? 0) + 1
        if (failingAddrs.length < 50) failingAddrs.push({ id: o.id, address: o.address, reason })
      } else {
        nycResolved++
        if (type && o.address) {
          resolvedSeen++
          const entry = { id: o.id, address: o.address, type, reason }
          if (spotCheck.length < 12) spotCheck.push(entry)
          else { const j = Math.floor(Math.random() * resolvedSeen); if (j < 12) spotCheck[j] = entry }
        }
      }
    }

    if ((o.propertyType ?? null) !== (type ?? null)) {
      correctionsCount++
      if (correctionSample.length < 25) {
        correctionSample.push({ id: o.id, address: o.address, before: o.propertyType ?? null, after: type ?? null })
      }
    }
  }

  await queue.addAll(cohort.map(o => async () => {
    if (aborted) return
    try {
      const result = await resolvePropertyType(o)
      await prisma.extractedOpportunity.update({
        where: { id: o.id },
        data: { propertyType: result.propertyType, propertyTypeReason: result.propertyTypeReason },
      })
      processed++; updated++
      tally(o, result.propertyType, result.propertyTypeReason)
    } catch (e) {
      processed++; errored++
      console.error(`  ✗ ${o.id} [${o.category}] threw: ${(e as Error).message}`)
    }

    if (processed % 500 === 0) {
      const tries = nycResolved + nycFailed
      const rate = tries > 0 ? ((nycFailed / tries) * 100).toFixed(2) : '0.00'
      console.log(`[backfill-pt] progress ${processed}/${cohort.length} | NYC tries ${tries} (resolved ${nycResolved}, failed ${nycFailed}) | NYC failure rate ${rate}%`)
    }

    const stop = checkHardStops()
    if (stop && !aborted) {
      aborted = true; abortReason = stop
      queue.clear()
      console.error(`\n⛔ HARD STOP at processed=${processed}: ${stop}`)
    }
  }))

  // ── Summary ──────────────────────────────────────────────────────────────────
  const sortDesc = (d: Record<string, number>) => Object.entries(d).sort((a, b) => b[1] - a[1])
  const pct = (n: number, d: number) => d > 0 ? ((n / d) * 100).toFixed(2) : 'n/a'
  const sumWhere = (pred: (r: string) => boolean) =>
    Object.entries(fullReasonDist).filter(([r]) => pred(r)).reduce((a, [, n]) => a + n, 0)

  console.log('\n═══════════════════════════════════════════════════════════════════')
  console.log('Phase 4.6 full backfill — Report')
  console.log(`  run state: ${aborted ? `ABORTED (${abortReason})` : 'completed'}`)
  console.log(`  processed: ${processed} / ${cohort.length}`)
  console.log(`  updated:   ${updated}`)
  console.log(`  errored:   ${errored}`)

  console.log('\n  overall propertyType distribution:')
  for (const [t, n] of sortDesc(typeDist)) console.log(`    ${t.padEnd(16)} ${String(n).padStart(6)}  (${pct(n, updated)}%)`)

  console.log('\n  reason 2-segment distribution (top 20):')
  for (const [p, n] of sortDesc(prefixDist).slice(0, 20)) console.log(`    ${p.padEnd(42)} ${String(n).padStart(6)}`)

  // NYC-bearing cohort — the metric that matters.
  const nycTotal = nycResolved + nycFailed
  console.log('\n  ── NYC-BEARING COHORT (rows we tried to resolve via PLUTO/ACRIS) ──')
  console.log(`    total      ${String(nycTotal).padStart(6)}`)
  console.log(`    resolved   ${String(nycResolved).padStart(6)}  (${pct(nycResolved, nycTotal)}%)`)
  console.log(`    failed     ${String(nycFailed).padStart(6)}  (${pct(nycFailed, nycTotal)}%)`)

  console.log('\n  NYC failure reasons (sorted):')
  for (const [k, v] of sortDesc(nycFailSub)) console.log(`    ${k.padEnd(42)} ${String(v).padStart(6)}`)
  if (Object.keys(nycFailSub).length === 0) console.log('    (none)')

  console.log('\n  honest skip breakdown (informational — expected nulls, NOT failures):')
  for (const p of HONEST_SKIP_PREFIXES) {
    const n = sumWhere(r => r === p || r.startsWith(p + ':'))
    if (n > 0) console.log(`    ${p.padEnd(42)} ${String(n).padStart(6)}`)
  }

  // Cache stats — derived from reasons (cached rows are prefixed "cached:").
  const cachedCount = sumWhere(r => r.startsWith('cached:'))
  const skipCount = sumWhere(r => r.startsWith('skipped:'))
  const nonSkip = updated - skipCount
  const freshGeoSearch = nonSkip - cachedCount      // every fresh non-skip row called GeoSearch once
  const freshPluto = sumWhere(r => r.startsWith('pluto')) // pluto_class*/pluto_no_record/pluto_unreachable (all fresh)
  const freshAcris = sumWhere(r => r.includes('+acris'))  // ownername_corp rows skip ACRIS
  console.log('\n  cache stats:')
  console.log(`    fresh GeoSearch calls  ${String(freshGeoSearch).padStart(6)}`)
  console.log(`    fresh PLUTO calls      ${String(freshPluto).padStart(6)}`)
  console.log(`    fresh ACRIS calls      ${String(freshAcris).padStart(6)}`)
  console.log(`    cached resolutions     ${String(cachedCount).padStart(6)}  (hit rate ${pct(cachedCount, nonSkip)}% of non-skip)`)

  console.log('\n  spot-check sample (random NYC opps, final result):')
  for (const s of spotCheck) console.log(`    ${s.id}  ${(s.address ?? '∅').slice(0, 38).padEnd(38)} ${(s.type ?? 'null').padEnd(14)} ${s.reason}`)

  console.log(`\n  propertyType corrections (pre != post): ${correctionsCount} total. Sample:`)
  for (const c of correctionSample) {
    console.log(`    before: ${String(c.before ?? 'null').padEnd(16)} → after: ${String(c.after ?? 'null').padEnd(14)} (${(c.address ?? '∅').slice(0, 40)})`)
  }

  if (aborted && failingAddrs.length) {
    console.log('\n  first failing NYC addresses (abort diagnostics):')
    for (const f of failingAddrs.slice(0, 30)) console.log(`    ${f.id}  ${(f.address ?? '∅').slice(0, 40).padEnd(40)} ${f.reason}`)
  }

  console.log('═══════════════════════════════════════════════════════════════════')
  if (aborted) console.log('NOTE: run aborted by a hard stop. NycParcelCache holds partial entries; re-running is idempotent and resumes where this left off.')

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('FATAL:', e)
  await prisma.$disconnect()
  process.exit(1)
})

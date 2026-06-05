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
}

async function buildCohort(): Promise<OppRow[]> {
  const where: Record<string, unknown> = {}
  if (IDS && IDS.length) where.id = { in: IDS }
  else if (!ALL) where.propertyTypeReason = null // default: only un-enriched rows
  if (CATEGORY) where.category = CATEGORY

  return prisma.extractedOpportunity.findMany({
    where,
    select: {
      id: true, organizationId: true, category: true, address: true,
      state: true, borough: true, neighborhood: true, propertyTypes: true,
    },
    orderBy: { createdAt: 'desc' },
    ...(LIMIT != null ? { take: LIMIT } : {}),
  })
}

// Bucket a reason to its first segment for the distribution summary.
function reasonPrefix(reason: string): string {
  return reason.split(/[:=+]/)[0] || '(empty)'
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('Phase 4.6 — propertyType backfill (NYC public-data enrichment)')
  console.log(`  flags: limit=${LIMIT ?? 'all'} category=${CATEGORY ?? 'any'} all=${ALL} dryRun=${DRY_RUN} ids=${IDS?.length ?? 0}`)
  console.log('═══════════════════════════════════════════════════════════════════')

  const cohort = await buildCohort()
  console.log(`\nCohort: ${cohort.length} opportunity row(s) ${ALL || IDS ? '' : '(propertyTypeReason IS NULL)'}.\n`)
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

  const queue = new PQueue({ concurrency: CONCURRENCY })
  let processed = 0, updated = 0, errored = 0
  const typeDist: Record<string, number> = {}
  const prefixDist: Record<string, number> = {}
  const fullReasonDist: Record<string, number> = {}

  function tally(type: string | null, reason: string) {
    const t = type ?? '(null)'
    typeDist[t] = (typeDist[t] ?? 0) + 1
    const p = reasonPrefix(reason)
    prefixDist[p] = (prefixDist[p] ?? 0) + 1
    fullReasonDist[reason] = (fullReasonDist[reason] ?? 0) + 1
  }

  await queue.addAll(cohort.map(o => async () => {
    try {
      const result = await resolvePropertyType(o)
      await prisma.extractedOpportunity.update({
        where: { id: o.id },
        data: { propertyType: result.propertyType, propertyTypeReason: result.propertyTypeReason },
      })
      processed++; updated++
      tally(result.propertyType, result.propertyTypeReason)
      if (processed % 25 === 0) console.log(`  … ${processed}/${cohort.length} processed`)
    } catch (e) {
      processed++; errored++
      console.error(`  ✗ ${o.id} [${o.category}] threw: ${(e as Error).message}`)
    }
  }))

  // ── Summary ──────────────────────────────────────────────────────────────────
  const sortDesc = (d: Record<string, number>) => Object.entries(d).sort((a, b) => b[1] - a[1])

  console.log('\n═══════════════════════════════════════════════════════════════════')
  console.log('Backfill summary')
  console.log(`  processed: ${processed}`)
  console.log(`  updated:   ${updated}`)
  console.log(`  errored:   ${errored}`)

  console.log('\n  propertyType distribution:')
  for (const [t, n] of sortDesc(typeDist)) console.log(`    ${t.padEnd(16)} ${n}`)

  console.log('\n  reason-prefix distribution:')
  for (const [p, n] of sortDesc(prefixDist)) console.log(`    ${p.padEnd(22)} ${n}`)

  console.log('\n  top full reasons:')
  for (const [r, n] of sortDesc(fullReasonDist).slice(0, 15)) console.log(`    ${String(n).padStart(5)}  ${r}`)
  console.log('═══════════════════════════════════════════════════════════════════')

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('FATAL:', e)
  await prisma.$disconnect()
  process.exit(1)
})

// Phase 4.0 — Reprocess the schema_validation_failed backlog with V2 extraction.
//
// Default cohort: emails behind a pending ReviewQueueItem with
// flagReason='schema_validation_failed' (the 681). For each email we ensure V2
// chunks exist (running ingestEmailV2 if not), then run V2 extraction. A
// successful extraction's wipe-and-insert transaction removes the stale stub
// opportunity + its review-queue row; a failed extraction is left untouched.
//
// Usage (a dry run unless --apply; --dry-run is still accepted):
//   INGEST_V2=true npx tsx scripts/reprocess-v2-extraction.ts [--limit N] [--category CAT] [--apply] [--max-cost USD]
import 'dotenv/config'
import PQueue from 'p-queue'
import { prisma } from '../lib/prisma'
import { getCurrentOrgId } from '../lib/auth/orgContext'
import { ingestEmailV2 } from '../lib/ingestion/ingestEmailV2'
import { extractEmailV2 } from '../lib/extraction/extractEmailV2'
import { isIngestionTestModeOnly } from '../lib/config/ingestionTestMode'
import { maintenanceApply } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): a dry run unless --apply, and --apply
// on a database that isn't *_perf / *_test also needs --i-mean-live.
const APPLY = maintenanceApply(process.env.DATABASE_URL, 'scripts/reprocess-v2-extraction.ts (DATABASE_URL)')

process.env.INGEST_V2 = 'true'

// ── Arg parsing ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const LIMIT    = flagValue('--limit') ? parseInt(flagValue('--limit')!, 10) : undefined
const CATEGORY = flagValue('--category')
const DRY_RUN  = !APPLY
const MAX_COST = flagValue('--max-cost') ? parseFloat(flagValue('--max-cost')!) : undefined
const IDS      = flagValue('--ids')?.split(',').map(s => s.trim()).filter(Boolean)  // target specific rawEmailIds
const CONCURRENCY = 5

interface Candidate {
  rawEmailId:    string
  subject:       string
  category:      string | null   // classifierCategory (what extraction routes on)
  oppCategory:   string | null   // the stub opportunity's category (what's in the queue)
  receivedAt:    Date
  chunkCount:    number
}

async function candidatesFromIds(organizationId: string, ids: string[]): Promise<Candidate[]> {
  const emails = await prisma.rawEmail.findMany({
    where:  { id: { in: ids } },
    select: { id: true, subject: true, classifierCategory: true, receivedDateTime: true },
  })
  const chunkCounts = await prisma.documentChunk.groupBy({
    by: ['parentEmailId'], where: { organizationId, parentEmailId: { in: ids } }, _count: { _all: true },
  })
  const chunkMap = new Map(chunkCounts.map(c => [c.parentEmailId, c._count._all]))
  return emails.map(e => ({
    rawEmailId: e.id, subject: e.subject, category: e.classifierCategory, oppCategory: null,
    receivedAt: e.receivedDateTime, chunkCount: chunkMap.get(e.id) ?? 0,
  }))
}

async function buildCohort(organizationId: string): Promise<Candidate[]> {
  if (IDS && IDS.length) return candidatesFromIds(organizationId, IDS)
  const items = await prisma.reviewQueueItem.findMany({
    where:  { organizationId, status: 'pending', flagReason: 'schema_validation_failed' },
    select: { rawEmailId: true, opportunityId: true },
  })

  // Resolve rawEmailId + category via the linked opportunity where needed.
  const oppIds = [...new Set(items.map(i => i.opportunityId).filter((x): x is string => !!x))]
  const opps = oppIds.length
    ? await prisma.extractedOpportunity.findMany({
        where:  { id: { in: oppIds } },
        select: { id: true, rawEmailId: true, category: true },
      })
    : []
  const oppMap = new Map(opps.map(o => [o.id, o]))

  const rawEmailIds = new Map<string, string | null>() // rawEmailId -> oppCategory
  for (const it of items) {
    const opp = it.opportunityId ? oppMap.get(it.opportunityId) : undefined
    const rid = it.rawEmailId ?? opp?.rawEmailId ?? null
    if (!rid) continue
    if (!rawEmailIds.has(rid)) rawEmailIds.set(rid, opp?.category ?? null)
  }

  const ids = [...rawEmailIds.keys()]
  if (ids.length === 0) return []

  const emails = await prisma.rawEmail.findMany({
    where:  { id: { in: ids } },
    select: { id: true, subject: true, classifierCategory: true, receivedDateTime: true },
  })
  const chunkCounts = await prisma.documentChunk.groupBy({
    by:    ['parentEmailId'],
    where: { organizationId, parentEmailId: { in: ids } },
    _count: { _all: true },
  })
  const chunkMap = new Map(chunkCounts.map(c => [c.parentEmailId, c._count._all]))

  let cohort: Candidate[] = emails.map(e => ({
    rawEmailId:  e.id,
    subject:     e.subject,
    category:    e.classifierCategory,
    oppCategory: rawEmailIds.get(e.id) ?? null,
    receivedAt:  e.receivedDateTime,
    chunkCount:  chunkMap.get(e.id) ?? 0,
  }))

  if (CATEGORY) {
    cohort = cohort.filter(c => c.oppCategory === CATEGORY || c.category === CATEGORY)
  }
  cohort.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
  if (LIMIT != null) cohort = cohort.slice(0, LIMIT)
  return cohort
}

async function main() {
  // Brief 6.0 — ingestion isolation gate. This script runs the real extractor
  // against real backlog emails (writes ExtractedOpportunity rows), so it must
  // not run while fixtures are being validated. Escape hatch: unset the flag.
  if (isIngestionTestModeOnly()) {
    console.log('[reprocess-v2] blocked: INGESTION_TEST_MODE_ONLY is on (unset it in .env to run against real data)')
    return
  }

  const organizationId = await getCurrentOrgId()
  const runStart = new Date()

  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('Phase 4.0 — V2 extraction reprocess')
  console.log(`  flags: limit=${LIMIT ?? 'all'} category=${CATEGORY ?? 'any'} dryRun=${DRY_RUN} maxCost=${MAX_COST ?? 'none'}`)
  console.log('═══════════════════════════════════════════════════════════════════')

  const cohort = await buildCohort(organizationId)
  console.log(`\nCohort: ${cohort.length} email(s) behind a pending schema_validation_failed review item.\n`)

  if (cohort.length === 0) { await prisma.$disconnect(); return }

  if (DRY_RUN) {
    for (const c of cohort) {
      console.log(
        `  • ${c.rawEmailId}  [${c.category ?? c.oppCategory ?? '?'}]  chunks=${c.chunkCount}` +
        `${c.chunkCount === 0 ? ' (will run ingestEmailV2 first)' : ''}\n      ${c.subject.slice(0, 100)}`,
      )
    }
    const byCat: Record<string, number> = {}
    for (const c of cohort) byCat[c.category ?? c.oppCategory ?? '?'] = (byCat[c.category ?? c.oppCategory ?? '?'] ?? 0) + 1
    console.log(`\n  categoryBreakdown: ${JSON.stringify(byCat)}`)
    console.log('\n  DRY RUN — no extraction performed. Re-run with --apply to extract them.')
    await prisma.$disconnect()
    return
  }

  const queue = new PQueue({ concurrency: CONCURRENCY })
  let processed = 0, succeeded = 0, failed = 0
  let aborted = false
  const categoryBreakdown: Record<string, { succeeded: number; failed: number }> = {}

  function tally(cat: string, ok: boolean) {
    categoryBreakdown[cat] ??= { succeeded: 0, failed: 0 }
    if (ok) categoryBreakdown[cat].succeeded++
    else categoryBreakdown[cat].failed++
  }

  await queue.addAll(cohort.map(c => async () => {
    if (aborted) return
    const cat = c.category ?? c.oppCategory ?? '?'
    try {
      if (c.chunkCount === 0) {
        // Runs chunking/embedding AND (via the wired-in step) extraction.
        await ingestEmailV2(c.rawEmailId)
      } else {
        await extractEmailV2(c.rawEmailId, organizationId)
      }
      const opps = await prisma.extractedOpportunity.findMany({
        where:  { organizationId, rawEmailId: c.rawEmailId },
        select: { id: true, category: true, address: true, neighborhood: true, confidenceScore: true, processingStatus: true },
      })
      // Success = clean V2 rows (processingStatus 'active'). A leftover V1 stub
      // is 'needs_review' and must NOT be counted as a success.
      const active = opps.filter(o => o.processingStatus === 'active')
      const staleStub = opps.length > active.length
      processed++
      const ok = active.length > 0
      if (ok) {
        succeeded++
        const sample = active[0]
        console.log(
          `  ✓ ${c.rawEmailId} [${cat}] → ${active.length} active opp(s); ` +
          `e.g. cat=${sample.category} addr=${sample.address ?? '∅'} nbhd=${sample.neighborhood ?? '∅'} conf=${sample.confidenceScore}`,
        )
      } else {
        failed++
        console.log(`  ✗ ${c.rawEmailId} [${cat}] → 0 active opp(s)${staleStub ? ' (V2 extracted nothing; V1 stub + review item left intact)' : ''}`)
      }
      tally(cat, ok)
    } catch (e) {
      processed++; failed++; tally(cat, false)
      console.error(`  ✗ ${c.rawEmailId} [${cat}] threw: ${(e as Error).message}`)
    }

    // Decision-tree cost guard. Wrapped so a transient DB blip (e.g. the
    // connection dropping when a laptop sleeps mid-run) skips one check instead
    // of crashing the whole drain — the run is idempotent and re-runnable.
    if (MAX_COST != null) {
      try {
        const agg = await prisma.aIExtractionLog.aggregate({
          where: { organizationId, model: 'claude-sonnet-4-6', createdAt: { gte: runStart } },
          _sum:  { estimatedCostUsd: true },
        })
        const spent = agg._sum.estimatedCostUsd ?? 0
        if (spent > MAX_COST) {
          aborted = true
          queue.clear()
          console.error(`\n  ⛔ Cost guard tripped: $${spent.toFixed(4)} > --max-cost $${MAX_COST}. Stopping.`)
        }
      } catch (e) {
        console.error(`  [cost-guard] skipped check (transient DB error): ${(e as Error).message}`)
      }
    }
  }))

  // Cost for this run (Sonnet extraction only — chunking/scrape/embed costs are separate).
  const costAgg = await prisma.aIExtractionLog.aggregate({
    where: { organizationId, model: 'claude-sonnet-4-6', createdAt: { gte: runStart } },
    _sum:  { estimatedCostUsd: true, inputTokens: true, outputTokens: true },
  })

  console.log('\n═══════════════════════════════════════════════════════════════════')
  console.log('Reprocess summary')
  console.log(`  processed:  ${processed}`)
  console.log(`  succeeded:  ${succeeded}`)
  console.log(`  failed:     ${failed}`)
  console.log(`  categoryBreakdown: ${JSON.stringify(categoryBreakdown)}`)
  console.log(`  Sonnet cost (this run): $${(costAgg._sum.estimatedCostUsd ?? 0).toFixed(4)} ` +
    `(in=${costAgg._sum.inputTokens ?? 0} out=${costAgg._sum.outputTokens ?? 0} tokens)`)
  if (aborted) console.log('  NOTE: run aborted early by cost guard.')
  console.log('═══════════════════════════════════════════════════════════════════')

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('FATAL:', e)
  await prisma.$disconnect()
  process.exit(1)
})

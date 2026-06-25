// scripts/catchup-v2-extract.ts
// One-shot catch-up: re-run classifier + V2 extraction on every RawEmail
// received since the INGEST_V2 gate landed (2026-06-04 21:07 EDT /
// 2026-06-05 01:07 UTC) that has no active ExtractedOpportunity row.
//
// Splits work by chunk presence:
//   - chunks exist → extractEmailV2 only (cheap, non-destructive)
//   - chunks absent → ingestEmailV2 end-to-end (full pipeline)
//
// Usage:
//   INGEST_V2=true npx tsx scripts/catchup-v2-extract.ts --dry-run
//   INGEST_V2=true npx tsx scripts/catchup-v2-extract.ts --confirm
//   INGEST_V2=true npx tsx scripts/catchup-v2-extract.ts --confirm --limit 10
//   INGEST_V2=true npx tsx scripts/catchup-v2-extract.ts --confirm --max-cost 25 --concurrency 5
import 'dotenv/config'
process.env.INGEST_V2 = 'true'
import PQueue from 'p-queue'
import { prisma } from '../lib/prisma'
import { getCurrentOrgId } from '../lib/auth/orgContext'
import { sourceClassifier } from '../lib/ingestion/sourceClassifier'
import { ingestEmailV2 } from '../lib/ingestion/ingestEmailV2'
import { extractEmailV2 } from '../lib/extraction/extractEmailV2'
import { runMatchmaking } from '../lib/matchmaking'

// Gate landed 2026-06-04 21:07 EDT (commit 3cccde1). UTC = 2026-06-05T01:07:16Z.
const GATE_TS = new Date('2026-06-05T01:07:16.000Z')

// ── Arg parsing ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const DRY_RUN     = argv.includes('--dry-run')
const CONFIRM     = argv.includes('--confirm')
const LIMIT       = flagValue('--limit')      ? parseInt(flagValue('--limit')!, 10)        : undefined
const MAX_COST    = flagValue('--max-cost')   ? parseFloat(flagValue('--max-cost')!)       : undefined
const CONCURRENCY = flagValue('--concurrency')? parseInt(flagValue('--concurrency')!, 10)  : 5

if (!DRY_RUN && !CONFIRM) {
  console.error('Refusing to run without --dry-run or --confirm. Pass one explicitly.')
  process.exit(1)
}

interface Candidate {
  id:                 string
  subject:            string
  senderName:         string | null
  senderEmail:        string | null
  bodyPreview:        string | null
  bodyContent:        string | null
  receivedDateTime:   Date
  classifierCategory: string | null
  chunkCount:         number
  attachmentNames:    string[]
  attachmentMimeTypes:string[]
}

async function buildCohort(organizationId: string): Promise<Candidate[]> {
  const rows = await prisma.rawEmail.findMany({
    where: {
      organizationId,
      createdAt:     { gte: GATE_TS },
      opportunities: { none: { processingStatus: 'active' } },
    },
    select: {
      id: true, subject: true, senderName: true, senderEmail: true,
      bodyPreview: true, bodyContent: true, receivedDateTime: true,
      classifierCategory: true,
      attachments: { select: { name: true, mimeType: true } },
    },
    orderBy: { createdAt: 'asc' },
    ...(LIMIT != null ? { take: LIMIT } : {}),
  })
  if (rows.length === 0) return []

  const ids = rows.map(r => r.id)
  const chunkCounts = await prisma.documentChunk.groupBy({
    by:     ['parentEmailId'],
    where:  { organizationId, parentEmailId: { in: ids } },
    _count: { _all: true },
  })
  const chunkMap = new Map(chunkCounts.map(c => [c.parentEmailId, c._count._all]))

  return rows.map(r => ({
    id:                  r.id,
    subject:             r.subject,
    senderName:          r.senderName,
    senderEmail:         r.senderEmail,
    bodyPreview:         r.bodyPreview,
    bodyContent:         r.bodyContent,
    receivedDateTime:    r.receivedDateTime,
    classifierCategory:  r.classifierCategory,
    chunkCount:          chunkMap.get(r.id) ?? 0,
    attachmentNames:     r.attachments.map(a => a.name).filter(Boolean) as string[],
    attachmentMimeTypes: r.attachments.map(a => a.mimeType).filter(Boolean) as string[],
  }))
}

// Categories the classifier marks needsDeepExtract=false (mirror of
// sourceClassifier STEP 3). Used to re-derive the gate for rows that already
// carry a category (a prior run / a smoke pass) where we don't have the
// classifier's original boolean to hand.
const NO_DEEP_EXTRACT = new Set(['NOISE', 'MARKET_REPORT', 'REAL_ESTATE_EVENT'])
function categoryNeedsDeepExtract(category: string | null): boolean {
  if (!category) return false
  return !NO_DEEP_EXTRACT.has(category)
}

// Returns the resolved category AND the classifier's needsDeepExtract so the
// caller can honor the same gate the live pipeline uses (informational
// categories like MARKET_REPORT / REAL_ESTATE_EVENT / NOISE → no extraction).
async function classifyIfNeeded(c: Candidate): Promise<{ category: string | null; needsDeepExtract: boolean }> {
  // Pre-existing tag (HOTSHEET sentinel / prior run / a smoke pass): preserve the
  // category but re-derive needsDeepExtract from it so we don't re-extract an
  // informational row. The HOTSHEET guard in the caller still skips the sentinel.
  if (c.classifierCategory) return { category: c.classifierCategory, needsDeepExtract: categoryNeedsDeepExtract(c.classifierCategory) }
  const classified = await sourceClassifier({
    rawEmailId:          c.id,
    subject:             c.subject,
    senderName:          c.senderName,
    senderEmail:         c.senderEmail,
    bodyPreview:         c.bodyPreview,
    bodyFirst500:        c.bodyContent ? c.bodyContent.slice(0, 500) : null,
    attachmentNames:     c.attachmentNames,
    attachmentMimeTypes: c.attachmentMimeTypes,
    attachmentCount:     c.attachmentNames.length,
  })
  await prisma.rawEmail.update({
    where: { id: c.id },
    data: {
      classifierStatus:     'classified',
      classifierCategory:   classified.category,
      classifierConfidence: classified.confidence,
      extractionStatus:     classified.needsDeepExtract ? 'pending' : 'skipped',
      lastProcessedAt:      new Date(),
    },
  }).catch(() => {})
  return { category: classified.category, needsDeepExtract: classified.needsDeepExtract }
}

async function main() {
  // Pre-flight env check.
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'VOYAGE_API_KEY', 'QDRANT_URL', 'DATABASE_URL']) {
    if (!process.env[k]) { console.error(`Missing env: ${k}`); process.exit(1) }
  }

  const organizationId = await getCurrentOrgId()
  const runStart = new Date()

  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('V2 catch-up: classifier + extraction for emails dropped since gate')
  console.log(`  gate:        ${GATE_TS.toISOString()}`)
  console.log(`  mode:        ${DRY_RUN ? 'DRY-RUN' : 'LIVE'}`)
  console.log(`  concurrency: ${CONCURRENCY}  limit: ${LIMIT ?? 'none'}  maxCost: ${MAX_COST ?? 'none'}`)
  console.log('═══════════════════════════════════════════════════════════════════')

  const cohort = await buildCohort(organizationId)
  console.log(`\nCohort: ${cohort.length} RawEmail rows since gate with no active opportunities.`)
  if (cohort.length === 0) { await prisma.$disconnect(); return }

  const withChunks    = cohort.filter(c => c.chunkCount > 0).length
  const withoutChunks = cohort.length - withChunks
  const needsClassify = cohort.filter(c => !c.classifierCategory).length
  const isHotsheet    = cohort.filter(c => c.classifierCategory === 'HOTSHEET').length

  console.log(`  with chunks       (extractEmailV2 only):  ${withChunks}`)
  console.log(`  without chunks    (ingestEmailV2 full):   ${withoutChunks}`)
  console.log(`  needs classifier  (classifierCategory NULL): ${needsClassify}`)
  console.log(`  HOTSHEET sentinel (will be skipped by extractor): ${isHotsheet}`)

  // Rough estimate: $0.025 per non-hotsheet email (Sonnet extract dominates).
  const projected = (cohort.length - isHotsheet) * 0.025
  console.log(`  projected Sonnet cost: ~$${projected.toFixed(2)}`)

  if (DRY_RUN) {
    console.log('\n  Sample (first 10):')
    for (const c of cohort.slice(0, 10)) {
      console.log(`    • ${c.id}  cat=${c.classifierCategory ?? 'NULL'}  chunks=${c.chunkCount}  ${c.subject.slice(0, 70)}`)
    }
    console.log('\n  DRY RUN — no work performed. Re-run with --confirm to execute.')
    await prisma.$disconnect()
    return
  }

  const queue = new PQueue({ concurrency: CONCURRENCY })
  const cohortIds = cohort.map(c => c.id)
  let processed = 0, ok = 0, skipped = 0, failed = 0
  let aborted = false
  const errors: string[] = []

  await queue.addAll(cohort.map(c => async () => {
    if (aborted) return
    const t0 = Date.now()
    try {
      let category: string | null

      if (c.chunkCount === 0) {
        // Full pipeline. ingestEmailV2's wired-in classifier (Task 1) runs because
        // classifierCategory is null, computes needsDeepExtract, and gates extraction
        // natively — exactly the live path. Pre-classifying here would set the category
        // first, making ingestEmailV2 default needsDeepExtract=true and extract
        // informational categories (MARKET_REPORT / REAL_ESTATE_EVENT) the live path
        // skips. So we let ingestEmailV2 own classification + the gate for this branch.
        await ingestEmailV2(c.id)
        const row = await prisma.rawEmail.findUnique({ where: { id: c.id }, select: { classifierCategory: true } })
        category = row?.classifierCategory ?? null
        if (category === 'HOTSHEET') {
          skipped++; processed++
          console.log(`  ⊘ ${c.id} [HOTSHEET] skipped (sentinel — no V2 extraction)`)
          return
        }
      } else {
        // Chunks already exist — classify (extractEmailV2 doesn't) and honor
        // needsDeepExtract so informational categories are skipped, matching the live path.
        const r = await classifyIfNeeded(c)
        category = r.category
        if (category === 'HOTSHEET') {
          skipped++; processed++
          console.log(`  ⊘ ${c.id} [HOTSHEET] skipped (sentinel — no V2 extraction)`)
          return
        }
        if (r.needsDeepExtract && category) {
          await extractEmailV2(c.id, organizationId)
        } else {
          skipped++; processed++
          console.log(`  ⊘ ${c.id} [${category ?? 'null'}] skipped (needsDeepExtract=false — informational)`)
          return
        }
      }

      const oppCount = await prisma.extractedOpportunity.count({
        where: { organizationId, rawEmailId: c.id, processingStatus: 'active' },
      })
      processed++
      if (oppCount > 0) {
        ok++
        console.log(`  ✓ ${c.id} [${category}] → ${oppCount} opp(s) in ${Date.now() - t0}ms`)
      } else {
        skipped++
        console.log(`  ∅ ${c.id} [${category}] → 0 opps (non-extractable category or empty result)`)
      }
    } catch (e) {
      processed++; failed++
      const msg = (e as Error).message
      errors.push(`${c.id}: ${msg}`)
      console.error(`  ✗ ${c.id} threw: ${msg}`)
    }

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
          console.error(`\n  ⛔ Cost guard tripped: $${spent.toFixed(4)} > $${MAX_COST}. Stopping.`)
        }
      } catch (e) {
        console.error(`  [cost-guard] skipped: ${(e as Error).message}`)
      }
    }

    if (processed % 25 === 0) {
      console.log(`  [progress] ${processed}/${cohort.length}  ok=${ok}  skipped=${skipped}  failed=${failed}`)
    }
  }))

  // Matchmaking on the new opportunities (mirrors lib/backgroundSync.ts:339).
  const newOpps = await prisma.extractedOpportunity.findMany({
    where:  { organizationId, rawEmailId: { in: cohortIds }, processingStatus: 'active' },
    select: { id: true },
  })
  const newOppIds = newOpps.map(o => o.id)
  let matchSummary = '0 matches'
  if (newOppIds.length > 0) {
    try {
      const m = await runMatchmaking(newOppIds)
      matchSummary = `${m.total} matches (${m.highConfidence} high-confidence)`
    } catch (e) {
      matchSummary = `runMatchmaking failed: ${(e as Error).message}`
    }
  }

  const costAgg = await prisma.aIExtractionLog.aggregate({
    where:  { organizationId, model: 'claude-sonnet-4-6', createdAt: { gte: runStart } },
    _sum:   { estimatedCostUsd: true, inputTokens: true, outputTokens: true },
    _count: { _all: true },
  })

  console.log('\n═══════════════════════════════════════════════════════════════════')
  console.log('Catch-up summary')
  console.log(`  cohort:    ${cohort.length}`)
  console.log(`  processed: ${processed}`)
  console.log(`  produced opps: ${ok}`)
  console.log(`  skipped (NOISE/HOTSHEET/empty): ${skipped}`)
  console.log(`  failed:    ${failed}`)
  console.log(`  Sonnet calls: ${costAgg._count._all}  cost: $${(costAgg._sum.estimatedCostUsd ?? 0).toFixed(4)}  ` +
    `(in=${costAgg._sum.inputTokens ?? 0} out=${costAgg._sum.outputTokens ?? 0})`)
  console.log(`  matchmaker: ${matchSummary}`)
  if (errors.length > 0) {
    console.log(`\n  First ${Math.min(errors.length, 10)} errors:`)
    errors.slice(0, 10).forEach(e => console.log(`    ${e}`))
  }
  if (aborted) console.log('  NOTE: run aborted early by cost guard.')
  console.log('═══════════════════════════════════════════════════════════════════')

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('FATAL:', e)
  await prisma.$disconnect()
  process.exit(1)
})

import PQueue from 'p-queue'
import { prisma } from '../prisma'
import { sourceClassifier, buildIdempotencyKey, CLASSIFIER_VERSION } from './sourceClassifier'
import { routeToExtractor } from './extractionRouter'
import { noiseHandler } from './extractors/noiseHandler'
import { logClassifier, logExtractor } from './costLogger'
import { resolvePropertyFromString } from '../properties/resolveProperty'
import type { ClassifierInput, ExtractorInput, ExtractionResult } from './types'
import { PROMPT_VERSION } from './types'

// Max 3 concurrent LLM calls to avoid rate-limit spikes during bulk sync
const queue = new PQueue({ concurrency: 3 })

// ── Status assignment rules ───────────────────────────────────────────────────
// Supply-side categories require an address to be active. Demand-side (ISO, renter) are ok without.
const SUPPLY_SIDE = new Set([
  'ACTIVE_SALE_LISTING', 'RENTAL_LISTING', 'COMING_SOON_SALE', 'COMING_SOON_RENTAL',
  'OFF_MARKET_SALE', 'BACK_ON_MARKET', 'PRICE_DROP', 'DEVELOPMENT_INVENTORY',
  'SPONSOR_UNIT', 'OPEN_HOUSE', 'SHOWING_CONFIRMATION',
])

function assignProcessingStatus(
  result: ExtractionResult,
  classifierConfidence: number,
): { status: string; flagReasons: string[] } {
  const flags: string[] = []
  let block = false

  // Schema validation already failed — caller sets category to 'NOISE' and passes schema_validation_failed
  if (result.flagReasons?.includes('schema_validation_failed')) {
    return { status: 'needs_review', flagReasons: ['schema_validation_failed'] }
  }

  // Ambiguous classifier
  if (classifierConfidence < 0.55) {
    flags.push('ambiguous_category')
    block = true
  }

  // Missing address on supply-side listings
  if (SUPPLY_SIDE.has(result.category) && !result.address) {
    // SHOWING_CONFIRMATION and OPEN_HOUSE without address are always blocked
    if (['SHOWING_CONFIRMATION', 'OPEN_HOUSE'].includes(result.category)) {
      flags.push('missing_address')
      block = true
    } else if (result.category !== 'PRICE_DROP' && result.category !== 'BACK_ON_MARKET') {
      flags.push('missing_address')
      block = true
    }
  }

  // Missing date on showing confirmations
  if (result.category === 'SHOWING_CONFIRMATION' && !result.availabilityDate) {
    flags.push('missing_date')
    block = true
  }

  // Price sanity
  if (result.price != null && (result.price > 100_000_000 || result.price < 500)) {
    flags.push('price_sanity')
    block = true
  }

  // Low confidence on supply-side → block; on demand-side → warning only
  if (result.confidenceScore < 0.65) {
    flags.push('low_confidence')
    if (SUPPLY_SIDE.has(result.category)) block = true
  }

  return {
    status: block ? 'needs_review' : 'active',
    flagReasons: flags,
  }
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function ingestEmail(input: ClassifierInput & {
  fullBody?: string | null
  attachmentText?: string | null
}): Promise<ExtractionResult[]> {
  return queue.add(async () => {
    const classifierKey = buildIdempotencyKey(input.rawEmailId, 'source_classifier', PROMPT_VERSION)

    // Idempotency: skip if this email was already classified with this prompt version
    const existingLog = await prisma.aIExtractionLog.findUnique({
      where: { idempotencyKey: classifierKey },
    })
    if (existingLog && !existingLog.error) {
      // Return existing extracted opportunities for this email
      const existing = await prisma.extractedOpportunity.findMany({
        where: { rawEmailId: input.rawEmailId },
      })
      return existing.map(o => ({
        isRelevant:           o.category !== 'NOISE',
        category:             o.category,
        transactionType:      o.transactionType,
        propertyType:         o.propertyType,
        address:              o.address,
        neighborhood:         o.neighborhood,
        borough:              o.borough,
        city:                 o.city,
        state:                o.state,
        zip:                  o.zip,
        price:                o.price,
        minPrice:             o.minPrice,
        maxPrice:             o.maxPrice,
        beds:                 o.beds,
        baths:                o.baths,
        units:                o.units,
        squareFeet:           o.squareFeet,
        availabilityDate:     o.availabilityDate,
        sourceAgentName:      o.sourceAgentName,
        sourceAgentEmail:     o.sourceAgentEmail,
        sourceBrokerage:      o.sourceBrokerage,
        clientSide:           o.clientSide,
        status:               o.status,
        extractedTitle:       o.extractedTitle,
        extractedSummary:     o.extractedSummary,
        classificationReason: o.classificationReason,
        confidenceScore:      o.confidenceScore,
        propertyId:           o.propertyId,
        processingStatus:     o.processingStatus,
      } as ExtractionResult))
    }

    // ── Step 1: Source classify (cheap — no full body) ────────────────────────
    const classifyStart = Date.now()
    const classified = await sourceClassifier(input)
    const classifyMs = Date.now() - classifyStart

    await logClassifier(input.rawEmailId, classifierKey, classified, classifyMs)

    // Update RawEmail checkpoint
    await prisma.rawEmail.update({
      where: { id: input.rawEmailId },
      data: {
        classifierStatus:   'classified',
        classifierCategory: classified.category,
        classifierConfidence: classified.confidence,
        extractionStatus:   classified.needsDeepExtract ? 'pending' : 'skipped',
        lastProcessedAt:    new Date(),
        idempotencyKey:     classifierKey,
      },
    }).catch(() => {}) // non-fatal — don't let checkpoint failure crash the pipeline

    if (!classified.needsDeepExtract) {
      const results = noiseHandler(input as ExtractorInput)
      await updateCheckpoint(input.rawEmailId, 'skipped', classified.category)
      return results
    }

    // ── Step 2: Deep extraction via specialized extractor ─────────────────────
    const extractorInput: ExtractorInput = {
      ...input,
      fullBody:       input.fullBody ?? null,
      attachmentText: input.attachmentText ?? null,
    }

    const extractorKey = buildIdempotencyKey(input.rawEmailId, classified.category, PROMPT_VERSION)
    const extractStart = Date.now()

    let rawResults: ExtractionResult[]
    try {
      rawResults = await routeToExtractor(classified.category, extractorInput)
      await updateCheckpoint(input.rawEmailId, 'extracted', classified.category)
    } catch (err) {
      const errMsg = (err as Error).message
      await logExtractor(input.rawEmailId, extractorKey, classified.category, CLASSIFIER_VERSION, [], Date.now() - extractStart, errMsg)
      await updateCheckpoint(input.rawEmailId, 'failed', classified.category, errMsg)
      // Fall back to noise so the email is still recorded
      return noiseHandler(extractorInput)
    }

    const extractMs = Date.now() - extractStart
    await logExtractor(input.rawEmailId, extractorKey, classified.category, CLASSIFIER_VERSION, rawResults, extractMs)

    // ── Step 3: Assign processingStatus + resolve properties ──────────────────
    const results: ExtractionResult[] = []
    for (const r of rawResults) {
      const { status, flagReasons } = assignProcessingStatus(r, classified.confidence)

      // Property resolution (Phase 2) — only for records with addresses
      let propertyId: string | null = null
      if (r.address && status !== 'needs_review') {
        try {
          propertyId = await resolvePropertyFromString(r.address, {
            borough:      r.borough,
            zip:          r.zip,
            neighborhood: r.neighborhood,
          })
        } catch { /* non-fatal */ }
      }

      results.push({
        ...r,
        propertyId,
        processingStatus: status,
        flagReasons,
      })
    }

    return results
  }) as Promise<ExtractionResult[]>
}

async function updateCheckpoint(
  rawEmailId: string,
  extractionStatus: string,
  extractorType: string,
  error?: string,
): Promise<void> {
  await prisma.rawEmail.update({
    where: { id: rawEmailId },
    data: {
      extractionStatus,
      extractorType,
      lastProcessedAt: new Date(),
      processingError: error ?? null,
      extractionAttempts: { increment: 1 },
    },
  }).catch(() => {})
}

// ── Backward-compat export (used by existing backgroundSync.ts via lib/ai.ts) ─
export { ingestEmail as classifyAndExtractEmailNew }

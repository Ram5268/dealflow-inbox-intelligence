import PQueue from 'p-queue'
import { prisma } from '../prisma'
import { sourceClassifier, buildIdempotencyKey, CLASSIFIER_VERSION } from './sourceClassifier'
import { routeToExtractor } from './extractionRouter'
import { noiseHandler } from './extractors/noiseHandler'
import { logClassifier, logExtractor } from './costLogger'
import { resolvePropertyFromString } from '../properties/resolveProperty'
import { validateResult, deriveStatus } from './validator'
import type { ClassifierInput, ExtractorInput, ExtractionResult } from './types'
import { PROMPT_VERSION } from './types'
import { findListingByAddress, QuotaExhaustedError } from '../streetEasySync'
import { SUPPLY_SALE, SUPPLY_RENTAL } from '../domain/Categories'

// Phase X.1 — categories that warrant an SE auto-match call at ingestion.
// Demand/lead/info records skip the lookup (they don't have a single SE
// listing to match against).
const SUPPLY_CATEGORIES = new Set<string>([...SUPPLY_SALE, ...SUPPLY_RENTAL])
const SUPPLY_RENTAL_SET = new Set<string>(SUPPLY_RENTAL)

// Max 3 concurrent LLM calls to avoid rate-limit spikes during bulk sync
const queue = new PQueue({ concurrency: 3 })

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

    // ── Step 3: Validate + assign processingStatus + resolve properties ──────
    const results: ExtractionResult[] = []
    for (const r of rawResults) {
      const flags     = await validateResult(r, classified.confidence)
      const status    = deriveStatus(flags)
      const flagReasons = flags.map(f => f.reason)

      // Property resolution — only for active supply-side records with addresses
      let propertyId: string | null = null
      if (r.address && status === 'active') {
        try {
          propertyId = await resolvePropertyFromString(r.address, {
            borough:      r.borough,
            zip:          r.zip,
            neighborhood: r.neighborhood,
          })
        } catch { /* non-fatal */ }
      }

      // Phase X.1 — SE auto-match for supply-side records with addresses.
      // Closes the email-ingestion gap: previously these records were saved
      // with streetEasyId=null and never got a status check unless the daily
      // cron eventually reached them. Quota gate in seRequest protects against
      // budget overrun; QuotaExhaustedError is swallowed so ingestion continues.
      let streetEasyId:        string | null = null
      let streetEasyStatus:    string | null = null
      let streetEasyCheckedAt: Date   | null = null
      if (r.address && SUPPLY_CATEGORIES.has(r.category)) {
        try {
          const isRental = SUPPLY_RENTAL_SET.has(r.category)
          const match    = await findListingByAddress(
            r.address,
            r.neighborhood,
            isRental ? 'rental' : 'sale',
            r.borough,
          )
          if (match) {
            streetEasyId        = match.id
            streetEasyStatus    = match.status ?? 'active'
            streetEasyCheckedAt = new Date()
          }
        } catch (e) {
          if (!(e instanceof QuotaExhaustedError)) {
            console.error('[ingestion] SE auto-match failed:', (e as Error).message)
          }
          // Either way, persist without SE fields — sweep can pick it up later.
        }
      }

      results.push({
        ...r,
        propertyId,
        processingStatus: status,
        flagReasons,
        duplicateOfId: r.duplicateOfId ?? null,
        streetEasyId,
        streetEasyStatus,
        streetEasyCheckedAt,
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

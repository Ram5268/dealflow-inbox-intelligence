import { prisma } from '../prisma'
import type { ClassifierOutput, ExtractionResult } from './types'
import { PROMPT_VERSION, SCHEMA_VERSION } from './types'

// Approximate cost per 1M tokens (May 2025 pricing)
const COST_PER_1M_INPUT  = 0.15  // gpt-4o-mini input
const COST_PER_1M_OUTPUT = 0.60  // gpt-4o-mini output

export async function logExtraction(opts: {
  rawEmailId:      string
  opportunityId?:  string | null
  idempotencyKey:  string
  extractorType:   string
  extractorVersion:string
  inputTokens?:    number
  outputTokens?:   number
  confidenceScore?:number
  durationMs?:     number
  error?:          string | null
}): Promise<void> {
  const { inputTokens = 0, outputTokens = 0 } = opts
  const estimatedCostUsd = (inputTokens / 1_000_000) * COST_PER_1M_INPUT
                         + (outputTokens / 1_000_000) * COST_PER_1M_OUTPUT

  try {
    await prisma.aIExtractionLog.upsert({
      where: { idempotencyKey: opts.idempotencyKey },
      update: {
        opportunityId:  opts.opportunityId ?? undefined,
        inputTokens,
        outputTokens,
        estimatedCostUsd,
        confidenceScore: opts.confidenceScore,
        durationMs:     opts.durationMs,
        error:          opts.error,
      },
      create: {
        rawEmailId:      opts.rawEmailId,
        opportunityId:   opts.opportunityId,
        idempotencyKey:  opts.idempotencyKey,
        model:           'gpt-4o-mini',
        extractorType:   opts.extractorType,
        extractorVersion:opts.extractorVersion,
        promptVersion:   PROMPT_VERSION,
        schemaVersion:   SCHEMA_VERSION,
        inputTokens,
        outputTokens,
        estimatedCostUsd,
        confidenceScore: opts.confidenceScore,
        durationMs:      opts.durationMs,
        error:           opts.error,
      },
    })
  } catch (e) {
    // Non-fatal — never let cost logging crash the pipeline
    console.error('[DealFlow costLogger] Failed to write AIExtractionLog:', (e as Error).message)
  }
}

export async function logClassifier(
  rawEmailId: string,
  idempotencyKey: string,
  classified: ClassifierOutput,
  durationMs: number,
): Promise<void> {
  await logExtraction({
    rawEmailId,
    idempotencyKey,
    extractorType:    'source_classifier',
    extractorVersion: classified.extractorVersion,
    confidenceScore:  classified.confidence,
    durationMs,
  })
}

export async function logExtractor(
  rawEmailId: string,
  idempotencyKey: string,
  extractorType: string,
  extractorVersion: string,
  results: ExtractionResult[],
  durationMs: number,
  error?: string,
): Promise<void> {
  const avgConf = results.length > 0
    ? results.reduce((s, r) => s + r.confidenceScore, 0) / results.length
    : undefined
  await logExtraction({
    rawEmailId,
    idempotencyKey,
    extractorType,
    extractorVersion,
    confidenceScore: avgConf,
    durationMs,
    error,
  })
}

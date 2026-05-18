import { prisma } from '../prisma'
import type { ExtractionResult, ValidationFlag } from './types'

const SUPPLY_SIDE = new Set([
  'ACTIVE_SALE_LISTING', 'RENTAL_LISTING', 'COMING_SOON_SALE', 'COMING_SOON_RENTAL',
  'OFF_MARKET_SALE', 'BACK_ON_MARKET', 'PRICE_DROP', 'DEVELOPMENT_INVENTORY',
  'SPONSOR_UNIT', 'OPEN_HOUSE', 'SHOWING_CONFIRMATION',
])

// Low-risk informational categories — low confidence is a warning, not a block
const LOW_RISK = new Set(['MARKET_REPORT', 'REAL_ESTATE_EVENT', 'CLIENT_CONVERSATION'])

export async function validateResult(
  result: ExtractionResult,
  classifierConfidence: number,
): Promise<ValidationFlag[]> {
  const flags: ValidationFlag[] = []

  // Already flagged by extractor (Zod parse failed)
  if (result.flagReasons?.includes('schema_validation_failed')) {
    flags.push({ reason: 'schema_validation_failed', severity: 'block', message: 'Zod schema validation failed — extractor returned malformed data' })
    return flags  // no point running further checks
  }

  // Ambiguous classifier
  if (classifierConfidence < 0.55) {
    flags.push({ reason: 'ambiguous_category', severity: 'block', message: `Classifier confidence ${Math.round(classifierConfidence * 100)}% is too low to trust the category` })
  }

  // Missing address on supply-side listings
  if (SUPPLY_SIDE.has(result.category) && !result.address) {
    // Demand-side-adjacent categories don't need an address (PRICE_DROP, BACK_ON_MARKET sometimes OK)
    const alwaysNeedAddress = ['ACTIVE_SALE_LISTING', 'RENTAL_LISTING', 'COMING_SOON_SALE',
      'COMING_SOON_RENTAL', 'OFF_MARKET_SALE', 'SHOWING_CONFIRMATION', 'OPEN_HOUSE',
      'DEVELOPMENT_INVENTORY', 'SPONSOR_UNIT']
    if (alwaysNeedAddress.includes(result.category)) {
      flags.push({ reason: 'missing_address', severity: 'block', message: `${result.category} requires an address but none was extracted` })
    }
  }

  // Missing date on showing confirmations
  if (result.category === 'SHOWING_CONFIRMATION' && !result.availabilityDate) {
    flags.push({ reason: 'missing_date', severity: 'block', message: 'Showing confirmation is missing the confirmed date/time' })
  }

  // Price sanity
  if (result.price != null && (result.price > 100_000_000 || result.price < 500)) {
    flags.push({ reason: 'price_sanity', severity: 'block', message: `Price $${result.price.toLocaleString()} is outside plausible range` })
  }

  // Low confidence
  if (result.confidenceScore < 0.65) {
    const isSupply = SUPPLY_SIDE.has(result.category)
    const isLowRisk = LOW_RISK.has(result.category)
    const severity = (isSupply && !isLowRisk) ? 'block' : 'warning'
    flags.push({ reason: 'low_confidence', severity, message: `Extraction confidence ${Math.round(result.confidenceScore * 100)}% is below threshold` })
  }

  // Possible duplicate: same address + same category within 30 days
  if (result.address && result.category !== 'NOISE') {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const existing = await prisma.extractedOpportunity.findFirst({
        where: {
          address:         { contains: result.address.slice(0, 20), mode: 'insensitive' },
          category:        result.category as never,
          isDuplicate:     false,
          processingStatus:{ notIn: ['rejected', 'duplicate'] },
          createdAt:       { gte: thirtyDaysAgo },
        },
        select: { id: true },
      })
      if (existing) {
        flags.push({ reason: 'possible_duplicate', severity: 'block', message: `Similar ${result.category} at this address already exists within 30 days` })
      }
    } catch { /* non-fatal — skip duplicate check on DB error */ }
  }

  return flags
}

// Determine processingStatus from flags
export function deriveStatus(flags: ValidationFlag[]): string {
  if (flags.some(f => f.severity === 'block')) return 'needs_review'
  return 'active'
}

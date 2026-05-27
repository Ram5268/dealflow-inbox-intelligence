import { prisma } from '../prisma'
import type { ExtractionResult, ValidationFlag } from './types'
import { normalizeAddress as canonicalNormalizeAddress } from '../domain/Address'

// SUPPLY_SIDE here historically also included SHOWING_CONFIRMATION (which
// lib/domain/Categories classifies as INFORMATIONAL). Preserved as a local
// set rather than the lib/domain SUPPLY_SALE ∪ SUPPLY_RENTAL because the
// validator uses it for address-required checks where SHOWING_CONFIRMATION
// is also address-required. Phase C can split that out cleanly.
const SUPPLY_SIDE = new Set([
  'ACTIVE_SALE_LISTING', 'RENTAL_LISTING', 'COMING_SOON_SALE', 'COMING_SOON_RENTAL',
  'OFF_MARKET_SALE', 'BACK_ON_MARKET', 'PRICE_DROP', 'DEVELOPMENT_INVENTORY',
  'SPONSOR_UNIT', 'OPEN_HOUSE', 'SHOWING_CONFIRMATION',
])

const LOW_RISK = new Set(['MARKET_REPORT', 'REAL_ESTATE_EVENT', 'CLIENT_CONVERSATION'])

// Normalize address for duplicate comparison. Wraps the canonical
// lib/domain/Address.normalizeAddress — keeps the legacy contract (lowercase
// string, slice to 30 chars) used by the duplicate-detection contains check.
function normalizeAddress(raw: string): string {
  const result = canonicalNormalizeAddress(raw)
  if (!result) return ''
  return result.normalized.slice(0, 30)
}

export async function validateResult(
  result: ExtractionResult,
  classifierConfidence: number,
): Promise<ValidationFlag[]> {
  const flags: ValidationFlag[] = []

  if (result.flagReasons?.includes('schema_validation_failed')) {
    flags.push({ reason: 'schema_validation_failed', severity: 'block', message: 'Zod schema validation failed — extractor returned malformed data' })
    return flags
  }

  if (classifierConfidence < 0.55) {
    flags.push({ reason: 'ambiguous_category', severity: 'block', message: `Classifier confidence ${Math.round(classifierConfidence * 100)}% is too low to trust the category` })
  }

  if (SUPPLY_SIDE.has(result.category) && !result.address) {
    const alwaysNeedAddress = ['ACTIVE_SALE_LISTING', 'RENTAL_LISTING', 'COMING_SOON_SALE',
      'COMING_SOON_RENTAL', 'OFF_MARKET_SALE', 'SHOWING_CONFIRMATION', 'OPEN_HOUSE',
      'DEVELOPMENT_INVENTORY', 'SPONSOR_UNIT']
    if (alwaysNeedAddress.includes(result.category)) {
      flags.push({ reason: 'missing_address', severity: 'block', message: `${result.category} requires an address but none was extracted` })
    }
  }

  if (result.category === 'SHOWING_CONFIRMATION' && !result.availabilityDate) {
    flags.push({ reason: 'missing_date', severity: 'block', message: 'Showing confirmation is missing the confirmed date/time' })
  }

  if (result.price != null && (result.price > 100_000_000 || result.price < 500)) {
    flags.push({ reason: 'price_sanity', severity: 'block', message: `Price $${result.price.toLocaleString()} is outside plausible range` })
  }

  if (result.confidenceScore < 0.65) {
    const isSupply = SUPPLY_SIDE.has(result.category)
    const isLowRisk = LOW_RISK.has(result.category)
    const severity = (isSupply && !isLowRisk) ? 'block' : 'warning'
    flags.push({ reason: 'low_confidence', severity, message: `Extraction confidence ${Math.round(result.confidenceScore * 100)}% is below threshold` })
  }

  // Duplicate detection — normalized address, upsert-not-block logic
  if (result.address && result.category !== 'NOISE') {
    try {
      const normalized = normalizeAddress(result.address)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      const existing = await prisma.extractedOpportunity.findFirst({
        where: {
          address:         { contains: normalized, mode: 'insensitive' },
          category:        result.category as never,
          isDuplicate:     false,
          processingStatus:{ notIn: ['rejected', 'duplicate'] },
          createdAt:       { gte: thirtyDaysAgo },
        },
        select: {
          id: true, address: true, price: true, beds: true, baths: true,
          neighborhood: true, sourceAgentName: true, sourceBrokerage: true,
        },
      })

      if (existing) {
        // Count populated fields to decide which record is richer
        const existingFilled = [existing.address, existing.price, existing.beds, existing.baths,
          existing.neighborhood, existing.sourceAgentName, existing.sourceBrokerage]
          .filter(v => v != null).length
        const incomingFilled = [result.address, result.price, result.beds, result.baths,
          result.neighborhood, result.sourceAgentName, result.sourceBrokerage]
          .filter(v => v != null).length

        if (incomingFilled > existingFilled) {
          // Incoming is richer — promote it, demote existing
          await prisma.extractedOpportunity.update({
            where: { id: existing.id },
            data: { isDuplicate: true, processingStatus: 'duplicate' },
          }).catch(() => {})
          // Don't block the incoming record — let it become active
        } else {
          // Existing is richer — block incoming, link it to the canonical record
          result.duplicateOfId = existing.id
          flags.push({ reason: 'possible_duplicate', severity: 'block',
            message: `Richer record for this address already exists (id: ${existing.id})` })
        }
      }
    } catch { /* non-fatal — skip duplicate check on DB error */ }
  }

  return flags
}

export function deriveStatus(flags: ValidationFlag[]): string {
  if (flags.some(f => f.severity === 'block')) return 'needs_review'
  return 'active'
}

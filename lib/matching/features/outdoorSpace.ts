import type { ListingData, BuyerData, FeatureResult } from '../scorerTypes'

const OUTDOOR_RE = /outdoor|terrace|garden|balcony|patio|roof\s?deck|backyard|back\s?yard|\byard\b/i

// If the buyer didn't ask for outdoor → 0.7 MEDIUM (doesn't care). If they did,
// score the listing; when unknown, fall back to a property-type-informed prior.
export function computeOutdoorSpace(listing: ListingData, buyer: BuyerData): FeatureResult {
  const key = 'outdoorSpace'
  const requires = OUTDOOR_RE.test(buyer.mustHaves ?? '')
  if (!requires) return { key, score: 0.7, confidence: 'MEDIUM' }

  if (listing.hasOutdoorSpace === true) return { key, score: 1.0, confidence: 'HIGH' }
  if (listing.hasOutdoorSpace === false) return { key, score: 0.05, confidence: 'HIGH' }

  const pt = (listing.propertyType ?? '').toLowerCase()
  if (pt.includes('townhouse')) return { key, score: 0.85, confidence: 'MEDIUM' }
  if (pt.includes('brownstone')) return { key, score: 0.75, confidence: 'MEDIUM' }
  if (pt.includes('condo')) return { key, score: 0.35, confidence: 'MEDIUM' }
  if (pt.includes('coop') || pt.includes('co-op')) return { key, score: 0.25, confidence: 'MEDIUM' }
  return { key, score: 0.5, confidence: 'LOW' }
}

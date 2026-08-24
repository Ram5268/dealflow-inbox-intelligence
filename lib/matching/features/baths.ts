import type { ListingData, BuyerData, FeatureResult } from '../scorerTypes'

// Brief 32.A.1 — now that BuyerData carries bathsMin/bathsMax, baths matches like
// a (softer) beds: exact in-range 1.0, within ±0.5 → 0.7, within ±1 → 0.3, else
// 0.05. Buyer stated no preference → neutral MEDIUM pass; listing unknown → LOW.
export function computeBaths(listing: ListingData, buyer: BuyerData): FeatureResult {
  const key = 'baths'
  const lb = listing.baths
  const bMin = buyer.bathsMin
  const bMax = buyer.bathsMax

  if (bMin == null && bMax == null) return { key, score: 0.7, confidence: 'MEDIUM' } // no preference
  if (lb == null) return { key, score: 0.5, confidence: 'LOW' } // listing baths unknown

  const min = bMin ?? 0
  const max = bMax ?? Number.POSITIVE_INFINITY

  if (lb >= min && lb <= max) return { key, score: 1.0, confidence: 'HIGH' }
  if (lb >= min - 0.5 && lb <= max + 0.5) return { key, score: 0.7, confidence: 'HIGH' }
  if (lb >= min - 1 && lb <= max + 1) return { key, score: 0.3, confidence: 'HIGH' }
  return { key, score: 0.05, confidence: 'HIGH' }
}

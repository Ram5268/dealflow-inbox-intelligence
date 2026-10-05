import type { ListingData, BuyerData, FeatureResult } from '../scorerTypes'
import { priceOverlapScore } from '../priceOverlap'
import { sellerPrice, fitProbability } from '../sellerPrice'
import { logit, fromLogit } from '../mathHelpers'

// Reuses the existing fractional priceOverlap. Tolerance widened to 0.15 to match
// the eligibility band. HIGH when both bounds + listing price are known; MEDIUM
// when the buyer side is an open/scalar range; LOW when a side is unknown.
// A seller known only by our estimated value scores the evidence its chance of
// fitting carries (sellerPrice.ts): the chance-weighted mix of "fits the budget"
// (score 1) and "doesn't" (score 0) in the scorer's logit space. A near-certain fit
// counts almost like a known in-budget price, a long shot almost like an
// out-of-budget one, and an even chance is neutral.
export function computePrice(listing: ListingData, buyer: BuyerData): FeatureResult {
  const key = 'price'
  const sp = sellerPrice(listing)
  if (sp == null || (buyer.priceMin == null && buyer.priceMax == null)) {
    return { key, score: 0.5, confidence: 'LOW' }
  }
  const bothBounds = buyer.priceMin != null && buyer.priceMax != null
  const confidence = bothBounds ? 'HIGH' : 'MEDIUM'
  if (sp.basis === 'estimate') {
    const chance = fitProbability(sp.price, buyer.priceMin, buyer.priceMax)
    return { key, score: estimateScore(chance), confidence }
  }
  return { key, score: priceOverlapScore(sp.price, buyer.priceMin, buyer.priceMax, 0.15), confidence }
}

export function estimateScore(chance: number): number {
  return fromLogit((2 * chance - 1) * logit(1))
}

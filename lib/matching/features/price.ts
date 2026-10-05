import type { ListingData, BuyerData, FeatureResult } from '../scorerTypes'
import { priceOverlapScore } from '../priceOverlap'
import { sellerPrice, fitProbability } from '../sellerPrice'

// Reuses the existing fractional priceOverlap. Tolerance widened to 0.15 to match
// the eligibility band. HIGH when both bounds + listing price are known; MEDIUM
// when the buyer side is an open/scalar range; LOW when a side is unknown.
// A seller known only by our estimated value scores the chance that its real price
// lands inside the buyer's budget ±15% (sellerPrice.ts), never above MEDIUM.
export function computePrice(listing: ListingData, buyer: BuyerData): FeatureResult {
  const key = 'price'
  const sp = sellerPrice(listing)
  if (sp == null || (buyer.priceMin == null && buyer.priceMax == null)) {
    return { key, score: 0.5, confidence: 'LOW' }
  }
  if (sp.basis === 'estimate') {
    return { key, score: fitProbability(sp.price, buyer.priceMin, buyer.priceMax), confidence: 'MEDIUM' }
  }
  const score = priceOverlapScore(sp.price, buyer.priceMin, buyer.priceMax, 0.15)
  const bothBounds = buyer.priceMin != null && buyer.priceMax != null
  return { key, score, confidence: bothBounds ? 'HIGH' : 'MEDIUM' }
}

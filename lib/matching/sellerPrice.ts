// Matching price ranges — where a supply row's price comes from, and how sure we
// are of it.
//   • An ExtractedOpportunity's price is a real asking price: a point.
//   • A seller contact whose listing EXPIRED or was WITHDRAWN matches on that
//     listing's last asking price: a point.
//   • Any other seller contact only has our estimated value (the estimatedValue
//     proxy in adapters.ts), matched as a ±25% range. In the 2025-26 back-test of
//     Brooklyn/Queens 2-4 family sales, ±25% around the estimate held the real sale
//     price for about 3 in 4 homes; ±15% (the old point gate) held only 56%.
// Pure, so eligibility, the price feature and the scarcity pre-compute share it.
import type { ListingData } from './scorerTypes'

export const ESTIMATE_BAND = 0.25

export type PriceBasis = 'asking' | 'last_asking' | 'estimate'

export interface SellerPriceRange {
  low: number
  high: number
  basis: PriceBasis
}

type PricedListing = Pick<ListingData, 'sourceType' | 'price' | 'priorListingStatus' | 'priorListingPrice'>

const OFF_MARKET_PRIOR = new Set(['EXPIRED', 'WITHDRAWN'])

export function sellerPriceRange(listing: PricedListing): SellerPriceRange | null {
  if (listing.sourceType !== 'contact') {
    return listing.price != null ? { low: listing.price, high: listing.price, basis: 'asking' } : null
  }
  const ask = listing.priorListingPrice
  if (listing.priorListingStatus != null && OFF_MARKET_PRIOR.has(listing.priorListingStatus) && ask != null && ask > 0) {
    return { low: ask, high: ask, basis: 'last_asking' }
  }
  const est = listing.price
  if (est == null || est <= 0) return null // no estimate → price unknown
  return { low: est * (1 - ESTIMATE_BAND), high: est * (1 + ESTIMATE_BAND), basis: 'estimate' }
}

// The price in the seller's range closest to the buyer's budget: inside the budget
// when the two overlap, otherwise the nearest end of the seller's range.
export function nearestPrice(range: SellerPriceRange, priceMin: number | null, priceMax: number | null): number {
  const lo = priceMin ?? 0
  const hi = priceMax ?? Number.POSITIVE_INFINITY
  if (range.high < lo) return range.high
  if (range.low > hi) return range.low
  return Math.max(range.low, lo)
}

// The single price to test a buyer's budget against; null when the seller's price
// is unknown (callers keep the pair, as before).
export function priceForBuyer(listing: PricedListing, priceMin: number | null, priceMax: number | null): number | null {
  const range = sellerPriceRange(listing)
  return range ? nearestPrice(range, priceMin, priceMax) : null
}

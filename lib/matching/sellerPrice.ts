// Matching price — where a supply row's price comes from, and how sure we are of it.
//   • An ExtractedOpportunity's price is a real asking price.
//   • A seller contact whose listing EXPIRED or was WITHDRAWN uses that listing's last
//     asking price.
//   • Any other seller contact only has our estimated value (the estimatedValue proxy in
//     adapters.ts). It is scored by the chance that the real price lands inside the
//     buyer's budget ±15%, read off how real sale prices spread around our estimates.
// Pure, so eligibility, the price feature and the scarcity pre-compute share it.
import type { ListingData } from './scorerTypes'

export type PriceBasis = 'asking' | 'last_asking' | 'estimate'

export interface SellerPrice {
  price: number
  basis: PriceBasis
}

type PricedListing = Pick<ListingData, 'sourceType' | 'price' | 'priorListingStatus' | 'priorListingPrice'>

const OFF_MARKET_PRIOR = new Set(['EXPIRED', 'WITHDRAWN'])

const usable = (v: number | null): v is number => v != null && Number.isFinite(v) && v > 0

export function sellerPrice(listing: PricedListing): SellerPrice | null {
  if (listing.sourceType !== 'contact') {
    return listing.price != null ? { price: listing.price, basis: 'asking' } : null
  }
  const status = listing.priorListingStatus?.trim().toUpperCase() ?? null
  if (status != null && OFF_MARKET_PRIOR.has(status) && usable(listing.priorListingPrice)) {
    return { price: listing.priorListingPrice, basis: 'last_asking' }
  }
  return usable(listing.price) ? { price: listing.price, basis: 'estimate' } : null // no usable estimate → price unknown
}

// How real sale prices spread around our estimates: quantiles of ln(sale price / estimate)
// for 2-4 family sales in Bed-Stuy, Bushwick, Crown Heights, Park Slope, Ridgewood, Ocean
// Hill, Greenpoint and Sunset Park, Sep 2024-Aug 2025 (DealFlow's valuation model, each
// month valued only from earlier sales). 1 in 10 sold 26% or more below the estimate and
// 1 in 10 sold 34% or more above it.
const SPREAD_P = [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.975, 0.99, 0.995]
const SPREAD_Q = [-1.7143, -0.9961, -0.7201, -0.4395, -0.3039, -0.166, -0.0877, -0.0294, 0.0221, 0.0757, 0.1314, 0.19, 0.2925, 0.38, 0.5121, 0.6464, 0.7273]

// Share of sales with ln(sale price / estimate) at or below v (linear between the quantiles).
function spreadCdf(v: number): number {
  const last = SPREAD_Q.length - 1
  if (v < SPREAD_Q[0]) return 0
  if (v > SPREAD_Q[last]) return 1
  let i = 0
  while (i < last - 1 && v > SPREAD_Q[i + 1]) i++
  const t = (v - SPREAD_Q[i]) / (SPREAD_Q[i + 1] - SPREAD_Q[i])
  return SPREAD_P[i] + t * (SPREAD_P[i + 1] - SPREAD_P[i])
}

// Chance that the real price of a home we estimate at `estimate` lands inside the buyer's
// budget with the usual 15% stretch on each side. Unusable inputs (a zero, negative or
// non-numeric max or estimate, a non-numeric min) give 0, like the point gate rejects them.
export function fitProbability(estimate: number, priceMin: number | null, priceMax: number | null): number {
  if (!(Number.isFinite(estimate) && estimate > 0)) return 0
  if (priceMax != null && !(priceMax > 0)) return 0
  if (priceMin != null && Number.isNaN(priceMin)) return 0
  const upper = priceMax != null ? spreadCdf(Math.log((priceMax * 1.15) / estimate)) : 1
  const lower = priceMin != null && priceMin > 0 ? spreadCdf(Math.log((priceMin * 0.85) / estimate)) : 0
  return Math.max(0, upper - lower)
}

// A seller known only by our estimate stays matched with a buyer when there is at least a
// 10% chance the buyer can afford the real price. In the 2025-26 back-test this found about
// as many real matches as a ±25% range around the estimate (95-99%, depending on how buyers
// state budgets) with about the same share of wrong-budget pairs, and ranked sellers much
// better, because a flat range gives every seller inside it the same price score.
export const MIN_FIT_PROBABILITY = 0.1

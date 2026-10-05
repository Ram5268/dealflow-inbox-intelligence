// Brief 32 — hard eligibility filter. Runs BEFORE scoring; an ineligible pair is
// never scored (scorePair short-circuits to matchFit=0). This encodes the
// non-negotiables (rental out-of-scope, REBNY solicitation compliance on
// currently-listed properties) and cheap geometric gates (neighborhood / beds /
// price) so the scorer only sees plausible pairs.
import type { ListingData, BuyerData } from './scorerTypes'
import { fromRaw, getAdjacent, getBorough } from '../domain/Neighborhood'
import { boroughLabels } from './borough'
import { sellerPrice, fitProbability, MIN_FIT_PROBABILITY } from './sellerPrice'

export function isEligible(
  listing: ListingData,
  buyer: BuyerData,
): { eligible: boolean; reason?: string } {
  // 1. Rentals are out of scope for the Brief 32 sales scorer.
  //    (The buyer rental-need enum is RENTER_NEED — the brief's 'RENTAL_NEED' was a typo.)
  if (listing.transactionType === 'RENTAL') return { eligible: false, reason: 'rental_out_of_scope' }
  if (buyer.transactionType === 'RENTER_NEED') return { eligible: false, reason: 'rental_out_of_scope' }

  // 2. Category compatibility — sales scorer only pairs against buyer demand.
  if (buyer.category !== 'BUYER_ISO') return { eligible: false, reason: 'not_buyer_iso' }

  // 3. Currently-listed properties (REBNY solicitation compliance).
  if (listing.priorListingStatus === 'ACTIVE') return { eligible: false, reason: 'currently_listed' }

  // 4. Neighborhood — in buyer's list, adjacent, or same borough.
  if (!isNeighborhoodEligible(listing.neighborhood, buyer.neighborhoods, listing.borough)) {
    return { eligible: false, reason: 'wrong_neighborhood' }
  }

  // 5. Beds — within ±1 of the buyer's stated range.
  if (!isBedsEligible(listing.beds, buyer.bedsMin, buyer.bedsMax)) {
    return { eligible: false, reason: 'wrong_beds' }
  }

  // 6. Price — within ±15% of the buyer's stated range. An expired/withdrawn seller
  //    uses its last asking price; one known only by our estimated value needs at
  //    least a 10% chance that its real price lands there (sellerPrice.ts).
  if (!isSellerPriceEligible(listing, buyer.priceMin, buyer.priceMax)) {
    return { eligible: false, reason: 'wrong_price' }
  }

  return { eligible: true }
}

export function isSellerPriceEligible(
  listing: ListingData,
  priceMin: number | null,
  priceMax: number | null,
): boolean {
  const sp = sellerPrice(listing)
  if (sp?.basis === 'estimate' && (priceMin != null || priceMax != null)) {
    return fitProbability(sp.price, priceMin, priceMax) >= MIN_FIT_PROBABILITY
  }
  return isPriceEligible(sp?.price ?? null, priceMin, priceMax)
}

// Exported for unit tests + reuse by substitution-scarcity pre-compute.
//
// Brief 35: borough-level areas on either side. A listing whose label isn't a
// known neighborhood falls back to its borough (listingBorough), and a buyer
// area that is a borough name ("Brooklyn") means the whole borough.
export function isNeighborhoodEligible(
  listingNbhd: string | null,
  buyerNbhds: string[],
  listingBorough: string | null = null,
): boolean {
  const lc = fromRaw(listingNbhd)
  const buyerCanon = buyerNbhds.map(n => fromRaw(n)).filter((n): n is string => n !== null)
  const buyerBoroughs = boroughLabels(buyerNbhds)
  if (buyerCanon.length === 0 && buyerBoroughs.length === 0) return true // no usable buyer area → keep
  const borough = lc ? getBorough(lc) : listingBorough
  if (borough && buyerBoroughs.includes(borough)) return true
  if (!lc) return borough ? buyerCanon.some(n => getBorough(n) === borough) : true // unknown listing area → keep
  if (buyerCanon.includes(lc)) return true
  const adjacents = getAdjacent(lc)
  if (buyerCanon.some(n => adjacents.includes(n))) return true
  return buyerCanon.some(n => getBorough(n) === borough)
}

export function isBedsEligible(
  listingBeds: number | null,
  bedsMin: number | null,
  bedsMax: number | null,
): boolean {
  if (listingBeds == null) return true // unknown → keep, feature will score MEDIUM
  if (bedsMin == null && bedsMax == null) return true
  const min = bedsMin ?? 0
  const max = bedsMax ?? Number.POSITIVE_INFINITY
  return listingBeds >= min - 1 && listingBeds <= max + 1 // ±1 tolerance
}

export function isPriceEligible(
  listingPrice: number | null,
  priceMin: number | null,
  priceMax: number | null,
): boolean {
  if (listingPrice == null) return true
  if (priceMin == null && priceMax == null) return true
  const min = (priceMin ?? 0) * 0.85 // 15% below allowed
  const max = (priceMax ?? Number.POSITIVE_INFINITY) * 1.15 // 15% above allowed
  return listingPrice >= min && listingPrice <= max
}

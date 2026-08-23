// Brief 32 — hard eligibility filter. Runs BEFORE scoring; an ineligible pair is
// never scored (scorePair short-circuits to matchFit=0). This encodes the
// non-negotiables (rental out-of-scope, REBNY solicitation compliance on
// currently-listed properties) and cheap geometric gates (neighborhood / beds /
// price) so the scorer only sees plausible pairs.
import type { ListingData, BuyerData } from './scorerTypes'
import { fromRaw, getAdjacent, getBorough } from '../domain/Neighborhood'

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
  if (!isNeighborhoodEligible(listing.neighborhood, buyer.neighborhoods)) {
    return { eligible: false, reason: 'wrong_neighborhood' }
  }

  // 5. Beds — within ±1 of the buyer's stated range.
  if (!isBedsEligible(listing.beds, buyer.bedsMin, buyer.bedsMax)) {
    return { eligible: false, reason: 'wrong_beds' }
  }

  // 6. Price — within ±15% of the buyer's stated range.
  if (!isPriceEligible(listing.price, buyer.priceMin, buyer.priceMax)) {
    return { eligible: false, reason: 'wrong_price' }
  }

  return { eligible: true }
}

// Exported for unit tests + reuse by substitution-scarcity pre-compute.
export function isNeighborhoodEligible(listingNbhd: string | null, buyerNbhds: string[]): boolean {
  if (!listingNbhd || buyerNbhds.length === 0) return true // unknown side → keep
  const lc = fromRaw(listingNbhd)
  if (!lc) return true // listing nbhd not recognized → keep (feature will differentiate)
  const buyerCanon = buyerNbhds.map(n => fromRaw(n)).filter((n): n is string => n !== null)
  if (buyerCanon.length === 0) return true // buyer nbhds unrecognized → keep
  if (buyerCanon.includes(lc)) return true
  const adjacents = getAdjacent(lc)
  if (buyerCanon.some(n => adjacents.includes(n))) return true
  const listingBorough = getBorough(lc)
  if (listingBorough && buyerCanon.some(n => getBorough(n) === listingBorough)) return true
  return false
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

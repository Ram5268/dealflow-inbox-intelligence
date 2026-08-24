import type { ListingData, BuyerData, ScoringContext } from '../scorerTypes'

// Brief 32.A.1 — agent-facing capture posture as an HONEST categorical label, not
// a fabricated probability. It reports only what we actually know: which side(s)
// Ryan represents. NOT part of MatchFit (fiduciary boundary).
export type CaptureStatus =
  | 'OWN_BOTH_SIDES'
  | 'OWN_LISTING_ONLY'
  | 'OWN_BUYER_ONLY'
  | 'EXTERNAL_BOTH'

export function computeCaptureStatus(
  listing: ListingData,
  buyer: BuyerData,
  context: ScoringContext,
): CaptureStatus {
  const ownsListing = context.ryanOwnedListingIds.has(listing.id)
  const repsBuyer = context.ryanRepresentedBuyerIds.has(buyer.id)
  if (ownsListing && repsBuyer) return 'OWN_BOTH_SIDES'
  if (ownsListing) return 'OWN_LISTING_ONLY'
  if (repsBuyer) return 'OWN_BUYER_ONLY'
  return 'EXTERNAL_BOTH'
}

import type { ListingData, BuyerData, ScoringContext } from '../scorerTypes'

// Agent-facing economics — NOT part of MatchFit (fiduciary boundary). Probability
// Ryan actually captures the commission on this pair, by representation posture.
export function computeCaptureProbability(
  listing: ListingData,
  buyer: BuyerData,
  context: ScoringContext,
): number {
  const rOwnsListing = context.ryanOwnedListingIds.has(listing.id)
  const rRepsBuyer = context.ryanRepresentedBuyerIds.has(buyer.id)

  if (rOwnsListing && rRepsBuyer) return 1.0
  if (rOwnsListing) return 0.6 // co-broke — external buyer may go dark
  if (rRepsBuyer) return 0.55 // co-broke offering unknown, engagement risk
  return 0.25 // both external — must sign buyer + engage listing agent
}

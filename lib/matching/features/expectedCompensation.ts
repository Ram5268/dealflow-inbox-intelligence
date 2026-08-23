import type { ListingData, BuyerData, ScoringContext } from '../scorerTypes'

// Agent-facing economics — NOT part of MatchFit. Stubbed to null: seed data
// carries no extracted commission and we do NOT fabricate a dollar figure. A
// follow-up brief will derive this from an extracted co-broke split when present.
export function computeExpectedGrossCompensation(
  _listing: ListingData,
  _buyer: BuyerData,
  _context: ScoringContext,
): number | null {
  return null
}

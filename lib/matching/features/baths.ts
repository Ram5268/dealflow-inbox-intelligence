import type { ListingData, BuyerData, FeatureResult } from '../scorerTypes'

// NOTE: the current data model carries no buyer-side baths preference (neither
// BuyerData nor MojoContact stores one), so baths cannot be matched the way beds
// is. We therefore treat baths presence as a mild positive (MEDIUM) and abstain
// (LOW) when the listing baths are unknown. Weight is intentionally low (0.7).
// Flagged for a follow-up brief: add buyer bathsMin to enable a real beds-style match.
export function computeBaths(listing: ListingData, _buyer: BuyerData): FeatureResult {
  const key = 'baths'
  if (listing.baths == null) return { key, score: 0.5, confidence: 'LOW' }
  return { key, score: 0.6, confidence: 'MEDIUM' }
}

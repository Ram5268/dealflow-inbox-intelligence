import type { ListingData, FeatureResult } from '../scorerTypes'

// Days until the scheduled auction — sooner = more urgent = better acquisition
// window. null auction date → LOW abstain.
export function computeForeclosureUrgency(listing: ListingData, now: Date): FeatureResult {
  const key = 'foreclosureUrgency'
  if (listing.foreclosureAuctionDate == null) return { key, score: 0.5, confidence: 'LOW' }
  const days = (listing.foreclosureAuctionDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  // Brief 48 (PR 9 review r1) [engineering precaution]: a date more than a day past says the
  // auction happened or moved, not that one is coming (a CRM upload's dates are a snapshot):
  // unknown, not the most urgent.
  if (days < -1) return { key, score: 0.5, confidence: 'LOW' }
  let score: number
  if (days <= 30) score = 1.0
  else if (days <= 60) score = 0.8
  else if (days <= 90) score = 0.6
  else score = 0.3
  return { key, score, confidence: 'HIGH' }
}

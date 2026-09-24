import type { ListingData, FeatureResult } from '../scorerTypes'

// Days until the scheduled auction — sooner = more urgent = better acquisition
// window. null auction date → LOW abstain.
export function computeForeclosureUrgency(listing: ListingData, now: Date): FeatureResult {
  const key = 'foreclosureUrgency'
  if (listing.foreclosureAuctionDate == null) return { key, score: 0.5, confidence: 'LOW' }
  const days = (listing.foreclosureAuctionDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
  let score: number
  if (days <= 30) score = 1.0
  else if (days <= 60) score = 0.8
  else if (days <= 90) score = 0.6
  else score = 0.3
  return { key, score, confidence: 'HIGH' }
}

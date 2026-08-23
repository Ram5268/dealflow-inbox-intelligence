import type { ListingData, FeatureResult } from '../scorerTypes'

// The single largest motivation signal (weight 3.0). NONE means we KNOW there's
// no distress (a real negative); null means we simply don't know (LOW abstain).
export function computePreForeclosure(listing: ListingData): FeatureResult {
  const key = 'preForeclosure'
  switch (listing.preForeclosureStatus) {
    case 'AUCTION_SCHEDULED': return { key, score: 1.0, confidence: 'HIGH' }
    case 'NOTICE_OF_DEFAULT': return { key, score: 0.85, confidence: 'HIGH' }
    case 'LIS_PENDENS': return { key, score: 0.75, confidence: 'HIGH' }
    case 'NONE': return { key, score: 0.3, confidence: 'HIGH' }
    default: return { key, score: 0.5, confidence: 'LOW' }
  }
}

import type { ListingData, FeatureResult } from '../scorerTypes'

// The Mojo list a contact came from is itself a motivation prior (a "NYC
// Pre-Foreclosure" list member is motivated by construction). A list with no
// clean signal → MEDIUM; no list → LOW abstain.
export function computeSourceListMotivation(listing: ListingData): FeatureResult {
  const key = 'sourceListMotivation'
  const list = listing.mojoList?.toLowerCase() ?? ''
  if (!list) return { key, score: 0.5, confidence: 'LOW' }
  if (list.includes('foreclosure') || list.includes('lis pendens')) return { key, score: 0.95, confidence: 'HIGH' }
  if (list.includes('vacant')) return { key, score: 0.85, confidence: 'HIGH' }
  if (list.includes('likely to sell')) return { key, score: 0.85, confidence: 'HIGH' }
  if (list.includes('expired')) return { key, score: 0.8, confidence: 'HIGH' }
  if (list.includes('absentee')) return { key, score: 0.75, confidence: 'HIGH' }
  if (list.includes('high equity')) return { key, score: 0.75, confidence: 'HIGH' }
  if (list.includes('tired landlord')) return { key, score: 0.75, confidence: 'HIGH' }
  return { key, score: 0.5, confidence: 'MEDIUM' }
}

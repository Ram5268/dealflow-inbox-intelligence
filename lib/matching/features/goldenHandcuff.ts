import type { ListingData, FeatureResult } from '../scorerTypes'

// Higher score = LESS rate-locked = MORE mobile. A sub-4% mortgage is a severe
// golden handcuff (they won't give it up to move). Unknown rate → LOW.
export function computeGoldenHandcuff(listing: ListingData): FeatureResult {
  const key = 'goldenHandcuff'
  const rate = listing.loanInterestRate
  if (rate == null) return { key, score: 0.5, confidence: 'LOW' }
  let score: number
  if (rate >= 6.0) score = 1.0
  else if (rate >= 5.0) score = 0.7
  else if (rate >= 4.5) score = 0.5
  else if (rate >= 4.0) score = 0.3
  else score = 0.1 // severe handcuff — locked-in low rate
  return { key, score, confidence: 'HIGH' }
}

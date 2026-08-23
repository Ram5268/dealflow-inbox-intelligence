import type { ListingData, FeatureResult } from '../scorerTypes'

// Vacant → strong sell signal (carrying an empty unit). Occupied → neutral.
export function computeVacancy(listing: ListingData): FeatureResult {
  const key = 'vacancy'
  if (listing.isVacant === true) return { key, score: 1.0, confidence: 'HIGH' }
  if (listing.isVacant === false) return { key, score: 0.4, confidence: 'HIGH' }
  return { key, score: 0.5, confidence: 'LOW' }
}

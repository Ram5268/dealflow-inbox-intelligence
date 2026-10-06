import type { ListingData, FeatureResult } from '../scorerTypes'
import { isAbsenteeOwner } from '../absentee'

// Absentee owners are likelier sellers. Explicit ownerOccupied=false → 1.0; a
// mailing street that differs from the property street also implies absentee
// (Brief 41: streets compared normalised, see absentee.ts).
export function computeAbsenteeOwner(listing: ListingData): FeatureResult {
  const key = 'absenteeOwner'
  const absentee = isAbsenteeOwner(listing)
  if (absentee === true) return { key, score: 1.0, confidence: 'HIGH' }
  if (absentee === false) return { key, score: 0.4, confidence: 'HIGH' }
  return { key, score: 0.5, confidence: 'LOW' }
}

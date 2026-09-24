import type { ListingData, FeatureResult } from '../scorerTypes'

function normAddr(a: string | null): string {
  return (a ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

// Absentee owners are likelier sellers. Explicit ownerOccupied=false → 1.0; a
// mailing address that differs from the property address also implies absentee.
export function computeAbsenteeOwner(listing: ListingData): FeatureResult {
  const key = 'absenteeOwner'
  if (listing.ownerOccupied === true) return { key, score: 0.4, confidence: 'HIGH' }
  if (listing.ownerOccupied === false) return { key, score: 1.0, confidence: 'HIGH' }
  const alt = normAddr(listing.alternateAddress)
  if (alt && alt !== normAddr(listing.address)) return { key, score: 1.0, confidence: 'HIGH' }
  return { key, score: 0.5, confidence: 'LOW' }
}

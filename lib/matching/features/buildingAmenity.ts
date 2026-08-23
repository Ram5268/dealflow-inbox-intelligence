import type { ListingData, BuyerData, FeatureResult } from '../scorerTypes'

const AMENITY_KEYWORDS: Record<string, RegExp> = {
  doorman: /doorman/i,
  gym: /\bgym\b|fitness/i,
  parking: /parking|garage/i,
  elevator: /elevator/i,
  laundry: /laundry|washer/i,
  pool: /\bpool\b/i,
}

// If the buyer requested no listed amenity → 0.7 MEDIUM. Otherwise compare against
// the listing's amenities: all present → 1.0, partial → fraction, none-but-known
// → 0.1, amenities unknown → 0.5 LOW.
export function computeBuildingAmenity(listing: ListingData, buyer: BuyerData): FeatureResult {
  const key = 'buildingAmenity'
  const wants = buyer.mustHaves ?? ''
  const required = Object.entries(AMENITY_KEYWORDS)
    .filter(([, re]) => re.test(wants))
    .map(([name]) => name)

  if (required.length === 0) return { key, score: 0.7, confidence: 'MEDIUM' }
  if (listing.amenities.length === 0) return { key, score: 0.5, confidence: 'LOW' }

  const have = new Set(listing.amenities.map(a => a.toLowerCase()))
  const present = required.filter(a => have.has(a))
  if (present.length === required.length) return { key, score: 1.0, confidence: 'HIGH' }
  if (present.length === 0) return { key, score: 0.1, confidence: 'HIGH' }
  return { key, score: present.length / required.length, confidence: 'HIGH' }
}

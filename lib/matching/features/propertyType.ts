import type { ListingData, BuyerData, FeatureResult } from '../scorerTypes'

// 1.0 if listing type is in the buyer's list; 0.8 (MEDIUM) if the buyer didn't
// specify; 0.2 if the listing type is set and NOT wanted; 0.5 (LOW) if unknown.
export function computePropertyType(listing: ListingData, buyer: BuyerData): FeatureResult {
  const key = 'propertyType'
  if (listing.propertyType == null) return { key, score: 0.5, confidence: 'LOW' }
  if (buyer.propertyTypes.length === 0) return { key, score: 0.8, confidence: 'MEDIUM' }
  const lt = listing.propertyType.toLowerCase().trim()
  const match = buyer.propertyTypes.some(p => {
    const bp = p.toLowerCase().trim()
    return bp === lt || lt.includes(bp) || bp.includes(lt)
  })
  return match ? { key, score: 1.0, confidence: 'HIGH' } : { key, score: 0.2, confidence: 'HIGH' }
}

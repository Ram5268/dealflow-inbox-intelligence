import type { ListingData, BuyerData, FeatureResult } from '../scorerTypes'
import { listingPropertyClasses, propertyClasses } from '../propertyTypes'

// 1.0 if listing type is in the buyer's list; 0.8 (MEDIUM) if the buyer didn't
// specify; 0.2 if the listing type is set and NOT wanted; 0.5 (LOW) if unknown.
//
// Brief 41: both sides go through one vocabulary (propertyTypes.ts), so a buyer's
// "Multifamily" matches a CRM "Duplex" / "Triplex" / "Multi-Family Dwelling". A
// mismatch is HIGH confidence only when every type on both sides is in that
// vocabulary; text we can't classify (e.g. "loft") makes it MEDIUM.
export function computePropertyType(listing: ListingData, buyer: BuyerData): FeatureResult {
  const key = 'propertyType'
  if (listing.propertyType == null) return { key, score: 0.5, confidence: 'LOW' }
  if (buyer.propertyTypes.length === 0) return { key, score: 0.8, confidence: 'MEDIUM' }

  const listingClasses = listingPropertyClasses(listing)
  const buyerContext = buyer.propertyTypes.join(' ')
  const buyerClasses = buyer.propertyTypes.map(p => propertyClasses(p, buyerContext))
  if (buyerClasses.some(cs => [...cs].some(c => listingClasses.has(c)))) return { key, score: 1.0, confidence: 'HIGH' }

  // Same words on both sides still count, whatever the class.
  const lt = listing.propertyType.toLowerCase().trim()
  const textMatch = buyer.propertyTypes.some(p => {
    const bp = p.toLowerCase().trim()
    return bp === lt || lt.includes(bp) || bp.includes(lt)
  })
  if (textMatch) return { key, score: 1.0, confidence: 'HIGH' }

  const allKnown = listingClasses.size > 0 && buyerClasses.every(cs => cs.size > 0)
  return { key, score: 0.2, confidence: allKnown ? 'HIGH' : 'MEDIUM' }
}

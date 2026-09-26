import type { ListingData, BuyerData, FeatureResult } from '../scorerTypes'
import { fromRaw, getAdjacent, getBorough } from '../../domain/Neighborhood'
import { boroughLabels } from '../borough'

// exact → 1.0, adjacent → 0.6, same-borough → 0.3 (all HIGH). Borough-level
// overlap only (Brief 35) → 0.3 MEDIUM. Unknown side → LOW.
// Eligibility guarantees at least a same-borough overlap, so the trailing floor
// is defensive.
export function computeNeighborhood(listing: ListingData, buyer: BuyerData): FeatureResult {
  const key = 'neighborhood'
  const lc = fromRaw(listing.neighborhood)
  const buyerCanon = buyer.neighborhoods.map(n => fromRaw(n)).filter((n): n is string => n !== null)
  if (lc && buyerCanon.length > 0) {
    if (buyerCanon.includes(lc)) return { key, score: 1.0, confidence: 'HIGH' }
    const adj = getAdjacent(lc)
    if (buyerCanon.some(n => adj.includes(n))) return { key, score: 0.6, confidence: 'HIGH' }
    const lb = getBorough(lc)
    if (lb && buyerCanon.some(n => getBorough(n) === lb)) return { key, score: 0.3, confidence: 'HIGH' }
    return { key, score: 0.3, confidence: 'HIGH' }
  }
  // Brief 35: only a borough-level overlap is knowable (the listing label or a
  // buyer area is a plain borough name): same-borough, at MEDIUM confidence.
  const borough = lc ? getBorough(lc) : listing.borough
  const buyerBoroughs = [...buyerCanon.map(n => getBorough(n)), ...boroughLabels(buyer.neighborhoods)]
  return borough && buyerBoroughs.includes(borough)
    ? { key, score: 0.3, confidence: 'MEDIUM' }
    : { key, score: 0.5, confidence: 'LOW' }
}

import type { ListingData, BuyerData, FeatureResult } from '../scorerTypes'
import { bedsScore } from '../bedsScore'

// Range-aware (Brief 30.2) bedsScore normalized to 0-1: in-range 20→1.0, a full
// bedroom outside 10→0.5 (a part-bedroom gap scores between, Brief 41), mismatch
// 0→0.0. The neutral 5 (a side genuinely unknown) maps to LOW/0.5 abstain.
export function computeBeds(listing: ListingData, buyer: BuyerData): FeatureResult {
  const key = 'beds'
  const raw = bedsScore(listing.beds, null, buyer.bedsMin, buyer.bedsMax)
  if (raw === 5) return { key, score: 0.5, confidence: 'LOW' }
  return { key, score: raw / 20, confidence: 'HIGH' }
}

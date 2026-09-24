import type { AggregatedContact, RankingFeatureResult } from '../types'

// Reward deals where Ryan already holds a side (higher capture certainty).
export function computeCaptureBonus(c: AggregatedContact): RankingFeatureResult {
  const s = c.topMatch.captureStatus
  const score = s === 'OWN_BOTH_SIDES' ? 1.0 : s === 'OWN_LISTING_ONLY' || s === 'OWN_BUYER_ONLY' ? 0.7 : 0.4
  return { key: 'captureBonus', score, confidence: 'HIGH' }
}

import type { ListingData, FeatureResult } from '../scorerTypes'

// Brief 32 BUG FIX — exponential decay with a 14-day half-life-ish constant,
// clamped to [0.1, 1.0]. Verified values (±0.02): 0d→1.00, 5d→0.70, 7d→0.61,
// 14d→0.37, 30d→0.12, 60d→0.10 (clamp floor).
export function computeRecency(listing: ListingData, now: Date): FeatureResult {
  const ageDays = (now.getTime() - listing.createdAt.getTime()) / (1000 * 60 * 60 * 24)
  const raw = Math.exp(-ageDays / 14)
  const score = Math.min(1.0, Math.max(0.1, raw))
  return { key: 'recency', score, confidence: 'HIGH' }
}

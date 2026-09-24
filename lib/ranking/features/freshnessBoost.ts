import type { AggregatedContact, RankingContext, RankingFeatureResult } from '../types'

// Newer matches deserve a nudge up the queue.
export function computeFreshnessBoost(c: AggregatedContact, ctx: RankingContext): RankingFeatureResult {
  const days = (ctx.now.getTime() - c.topMatch.createdAt.getTime()) / (1000 * 60 * 60 * 24)
  const score = days <= 3 ? 1.0 : days <= 7 ? 0.8 : days <= 14 ? 0.6 : days <= 30 ? 0.4 : 0.2
  return { key: 'freshnessBoost', score, confidence: 'HIGH' }
}

import type { AggregatedContact, RankingContext, RankingFeatureResult } from '../types'

// Higher score = LESS recently called = more callable NOW. Never-called is a
// clean 1.0; called yesterday is a near-zero no-go.
export function computeCooldownPenalty(c: AggregatedContact, ctx: RankingContext): RankingFeatureResult {
  const times = [c.contact.lastCalled, c.contact.lastDialDate].filter((d): d is Date => d != null)
  if (times.length === 0) return { key: 'cooldownPenalty', score: 1.0, confidence: 'HIGH' }
  const lastTouched = new Date(Math.max(...times.map(d => d.getTime())))
  const days = (ctx.now.getTime() - lastTouched.getTime()) / (1000 * 60 * 60 * 24)
  const score = days >= 30 ? 1.0 : days >= 14 ? 0.7 : days >= 7 ? 0.4 : days >= 3 ? 0.2 : 0.05
  return { key: 'cooldownPenalty', score, confidence: 'HIGH' }
}

import type { AggregatedContact, RankingFeatureResult } from '../types'

// The contact's best match quality — the single most important ranking signal.
export function computeMatchFitLift(c: AggregatedContact): RankingFeatureResult {
  return { key: 'matchFitLift', score: c.topMatch.matchFit / 100, confidence: 'HIGH' }
}

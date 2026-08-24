import type { AggregatedContact, RankingFeatureResult } from '../types'

// Boost matches the scorer was confident about (few abstaining features).
export function computeMatchFitConfidenceLift(c: AggregatedContact): RankingFeatureResult {
  const score = c.topMatch.matchFitConfidence === 'HIGH' ? 1.0 : c.topMatch.matchFitConfidence === 'MEDIUM' ? 0.6 : 0.3
  return { key: 'matchFitConfidenceLift', score, confidence: 'HIGH' }
}

// Brief 33 — ranking weights. SEPARATE config from the scorer's weights (these
// rank contacts into a call queue; the scorer's weights rank fit within a pair).
// Relative magnitudes are what matter; tune after observing the distribution.
export const RANKING_WEIGHTS: Record<string, number> = {
  matchFitLift:           3.0, // most important — the actual match quality
  captureBonus:           1.5, // OWN_BOTH_SIDES = pure win, EXTERNAL_BOTH less
  motivationSummary:      1.2, // any HOT match with a distress signal
  matchFitConfidenceLift: 1.0, // HIGH-confidence matches boosted
  cooldownPenalty:        0.9, // recently called = deprioritize
  freshnessBoost:         0.8, // new matches deserve a nudge
  reachabilityBonus:      0.5, // more non-DNC phones = easier to reach
}

export function getRankingWeight(key: string): number {
  if (!(key in RANKING_WEIGHTS)) {
    throw new Error(`No ranking weight configured for feature key: ${key}`)
  }
  return RANKING_WEIGHTS[key]
}

// Brief 33 — CallPriority composition. Same logit-space additive shape as the
// scorer's composeMatchFit, but a DIFFERENT feature set and NO bias term (we want
// the full 0-100 range for ranking spread). All Brief 33 features return HIGH;
// the CONF_WEIGHT tri-state is kept for forward compatibility.
import { logit, sigmoid } from '../matching/mathHelpers'
import type { Confidence, RankingFeatureResult } from './types'
import { getRankingWeight } from './weights'

const CONF_WEIGHT: Record<Confidence, number> = { HIGH: 1.0, MEDIUM: 0.5, LOW: 0.1 }

export function composeCallPriority(
  features: RankingFeatureResult[],
): { priorityScore: number; contributions: Record<string, number> } {
  let weightedRaw = 0
  let weightedTotalConf = 0
  let weightedTotalAbs = 0
  const perFeatureAbs: Record<string, number> = {}

  for (const f of features) {
    const w = getRankingWeight(f.key) // throws if a feature key has no weight
    const c = CONF_WEIGHT[f.confidence]
    const effective = w * c
    const contrib = effective * logit(f.score)
    const abs = Math.abs(contrib)
    weightedRaw += contrib
    weightedTotalConf += effective
    weightedTotalAbs += abs
    perFeatureAbs[f.key] = abs
  }

  if (weightedTotalConf === 0) {
    return { priorityScore: 50, contributions: {} }
  }

  const normalized = weightedRaw / weightedTotalConf // no bias, unlike the scorer
  const priorityScore = Math.round(sigmoid(normalized) * 100)

  const contributions: Record<string, number> = {}
  if (weightedTotalAbs > 0) {
    for (const [k, abs] of Object.entries(perFeatureAbs)) {
      contributions[k] = Math.round((abs / weightedTotalAbs) * 100)
    }
  }

  return { priorityScore, contributions }
}

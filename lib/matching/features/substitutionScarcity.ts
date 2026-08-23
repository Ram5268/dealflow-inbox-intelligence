import type { BuyerData, ScoringContext, FeatureResult } from '../scorerTypes'

// Scarcity from the BUYER's vantage: how many active listings match their core
// criteria. Fewer substitutes → this listing is more valuable to them. Count is
// pre-computed into context.substitutionCounts; absence → LOW abstain.
export function computeSubstitutionScarcity(buyer: BuyerData, context: ScoringContext): FeatureResult {
  const key = 'substitutionScarcity'
  const count = context.substitutionCounts.get(buyer.id)
  if (count == null) return { key, score: 0.5, confidence: 'LOW' }
  let score: number
  if (count <= 3) score = 1.0
  else if (count <= 10) score = 0.7
  else if (count <= 30) score = 0.4
  else score = 0.2
  return { key, score, confidence: 'HIGH' }
}

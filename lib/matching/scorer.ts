// Brief 32 — the pair-level SALES scorer. Produces three separable facts per
// (listing, buyer) pair: MatchFit (client-facing 0-100 fit), CaptureProbability
// (agent-facing likelihood Ryan captures the deal), and ExpectedGrossCompensation
// (agent-facing $, currently null). MatchFit never sees commission dollars —
// that fiduciary boundary is the whole point of the split.
//
// Composition is LOGIT-SPACE ADDITIVE: each HIGH/MEDIUM feature contributes
// weight × confidence × logit(score); LOW features ABSTAIN (don't vote, and are
// surfaced in unknownFactors). The weighted sum is normalized by the total
// effective weight, then squashed through sigmoid → [0,100].
import { logit, sigmoid } from './mathHelpers'
import { getWeight } from './weights'
import { isEligible } from './eligibility'
import type {
  FeatureResult,
  MatchFitResult,
  ListingData,
  BuyerData,
  ScoringContext,
} from './scorerTypes'

import { computeNeighborhood } from './features/neighborhood'
import { computePrice } from './features/price'
import { computeBeds } from './features/beds'
import { computeBaths } from './features/baths'
import { computePropertyType } from './features/propertyType'
import { computeCarryingReasonableness } from './features/carryingReasonableness'
import { computeOutdoorSpace } from './features/outdoorSpace'
import { computeBuildingAmenity } from './features/buildingAmenity'
import { computeHighEquity } from './features/highEquity'
import { computeFreeAndClear } from './features/freeAndClear'
import { computeGoldenHandcuff } from './features/goldenHandcuff'
import { computeAbsenteeOwner } from './features/absenteeOwner'
import { computeVacancy } from './features/vacancy'
import { computePreForeclosure } from './features/preForeclosure'
import { computeForeclosureUrgency } from './features/foreclosureUrgency'
import { computeTenure } from './features/tenure'
import { computeSourceListMotivation } from './features/sourceListMotivation'
import { computeSubstitutionScarcity } from './features/substitutionScarcity'
import { computeBuyerArchetypeSituation } from './features/buyerArchetypeSituation'
import { computeRecency } from './features/recency'
import { computeCaptureProbability } from './features/captureProbability'
import { computeExpectedGrossCompensation } from './features/expectedCompensation'

// Re-export the brief's stated scorer.ts type surface.
export type { Confidence, FeatureResult, MatchFitResult, ScoringContext } from './scorerTypes'

export function composeMatchFit(features: FeatureResult[]): MatchFitResult {
  let weightedRaw = 0
  let weightedTotalConf = 0
  let weightedTotalAbs = 0
  const unknownFactors: string[] = []
  const perFeatureAbs: Record<string, number> = {}

  for (const f of features) {
    if (f.confidence === 'LOW') {
      unknownFactors.push(f.key)
      continue // ABSTAIN — do not vote
    }
    const w = getWeight(f.key) // throws if a feature key has no configured weight
    const c = f.confidence === 'HIGH' ? 1.0 : 0.5 // MEDIUM = half weight
    const effective = w * c
    const contrib = effective * logit(f.score)
    const abs = Math.abs(contrib)
    weightedRaw += contrib
    weightedTotalConf += effective
    weightedTotalAbs += abs
    perFeatureAbs[f.key] = abs
  }

  if (weightedTotalConf === 0) {
    // All features abstained. Neutral is the honest default.
    return { matchFit: 50, contributions: {}, unknownFactors }
  }

  const normalized = weightedRaw / weightedTotalConf
  const matchFit = Math.round(sigmoid(normalized) * 100)

  const contributions: Record<string, number> = {}
  if (weightedTotalAbs > 0) {
    for (const [k, abs] of Object.entries(perFeatureAbs)) {
      contributions[k] = Math.round((abs / weightedTotalAbs) * 100)
    }
  }

  return { matchFit, contributions, unknownFactors }
}

export function scorePair(
  listing: ListingData,
  buyer: BuyerData,
  context: ScoringContext,
): {
  matchFit: MatchFitResult
  captureProbability: number | null
  expectedGrossCompensation: number | null
  eligibility: { eligible: boolean; reason?: string }
} {
  const eligibility = isEligible(listing, buyer)
  if (!eligibility.eligible) {
    return {
      matchFit: { matchFit: 0, contributions: {}, unknownFactors: [] },
      captureProbability: 0,
      expectedGrossCompensation: null,
      eligibility,
    }
  }

  const features: FeatureResult[] = [
    computeNeighborhood(listing, buyer),
    computePrice(listing, buyer),
    computeBeds(listing, buyer),
    computeBaths(listing, buyer),
    computePropertyType(listing, buyer),
    computeCarryingReasonableness(listing, context),
    computeOutdoorSpace(listing, buyer),
    computeBuildingAmenity(listing, buyer),
    computeHighEquity(listing),
    computeFreeAndClear(listing),
    computeGoldenHandcuff(listing),
    computeAbsenteeOwner(listing),
    computeVacancy(listing),
    computePreForeclosure(listing),
    computeForeclosureUrgency(listing, context.now),
    computeTenure(listing, context.now),
    computeSourceListMotivation(listing),
    computeSubstitutionScarcity(buyer, context),
    computeBuyerArchetypeSituation(listing, buyer),
    computeRecency(listing, context.now),
  ]

  const matchFit = composeMatchFit(features)
  const captureProbability = computeCaptureProbability(listing, buyer, context)
  const expectedGrossCompensation = computeExpectedGrossCompensation(listing, buyer, context)

  return { matchFit, captureProbability, expectedGrossCompensation, eligibility }
}

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
import { sellerPrice, fitProbability } from './sellerPrice'
import { HOT_MIN_FIT, WARM_MIN_FIT } from './tiers'
import type {
  Confidence,
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
import { computeCaptureStatus, type CaptureStatus } from './features/captureStatus'

// Re-export the brief's stated scorer.ts type surface.
export type { Confidence, FeatureResult, MatchFitResult, ScoringContext } from './scorerTypes'
export type { CaptureStatus } from './features/captureStatus'

// Brief 32.A.1 — global pessimism prior applied AFTER normalization (see below).
// It shifts a neutral pair (normalized 0) to sigmoid(-0.5) ≈ 0.38 → matchFit 38,
// pulling the whole distribution down so HOT is earned, not default. Folding it
// into weightedRaw (pre-division) would divide it by the total weight and erase it.
const BIAS_LOGIT = -0.5

// Brief 32.A.1 — matchFit confidence from how much of the feature suite abstained.
function confidenceFromAbstentions(n: number): Confidence {
  return n <= 4 ? 'HIGH' : n <= 8 ? 'MEDIUM' : 'LOW'
}

export function composeMatchFit(features: FeatureResult[]): MatchFitResult {
  let weightedRaw = 0
  let weightedTotalConf = 0
  let weightedTotalAbs = 0
  const unknownFactors: string[] = []
  const perFeatureAbs: Record<string, number> = {}
  const signed: Array<[string, number]> = []

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
    signed.push([f.key, contrib])
  }

  const matchFitConfidence = confidenceFromAbstentions(unknownFactors.length)

  if (weightedTotalConf === 0) {
    // All features abstained. Neutral is the honest default.
    return { matchFit: 50, matchFitConfidence: 'LOW', contributions: {}, unknownFactors }
  }

  // NORMALIZE FIRST, THEN APPLY BIAS (critical — see BIAS_LOGIT note above).
  const normalized = weightedRaw / weightedTotalConf + BIAS_LOGIT
  const matchFit = Math.round(sigmoid(normalized) * 100)

  const contributions: Record<string, number> = {}
  if (weightedTotalAbs > 0) {
    for (const [k, abs] of Object.entries(perFeatureAbs)) {
      contributions[k] = Math.round((abs / weightedTotalAbs) * 100)
    }
  }

  const strongestFirst = (xs: Array<[string, number]>) => xs.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([k]) => k)
  const helped = strongestFirst(signed.filter(([, c]) => c > 0))
  const hurt = strongestFirst(signed.filter(([, c]) => c < 0))

  return { matchFit, matchFitConfidence, contributions, unknownFactors, helped, hurt }
}

export function scorePair(
  listing: ListingData,
  buyer: BuyerData,
  context: ScoringContext,
): {
  matchFit: MatchFitResult
  captureStatus: CaptureStatus
  eligibility: { eligible: boolean; reason?: string }
} {
  const eligibility = isEligible(listing, buyer)
  if (!eligibility.eligible) {
    return {
      matchFit: { matchFit: 0, matchFitConfidence: 'LOW', contributions: {}, unknownFactors: [] },
      captureStatus: computeCaptureStatus(listing, buyer, context),
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
    // Brief 41 (M9): a seller contact has no market-event date (its createdAt is
    // the DealFlow import date), so recency doesn't apply to it at all. Leaving
    // it out, rather than abstaining, keeps it from counting as an unknown factor
    // and pushing every CRM seller's matchFit confidence down a level.
    ...(listing.sourceType === 'contact' ? [] : [computeRecency(listing, context.now)]),
  ]

  const matchFit = {
    ...capForPriceChance(composeMatchFit(features), listing, buyer),
    priceFromEstimate: sellerPrice(listing)?.basis === 'estimate',
  }
  const captureStatus = computeCaptureStatus(listing, buyer, context)

  return { matchFit, captureStatus, eligibility }
}

// A seller known only by our estimated value can't look like a strong match for a
// buyer who probably can't afford it: HOT needs at least an even chance that the real
// price fits the budget, WARM at least a 25% chance (sellerPrice.ts). Known prices are
// untouched.
export const HOT_MIN_PRICE_CHANCE = 0.5
export const WARM_MIN_PRICE_CHANCE = 0.25

export function capForPriceChance(mf: MatchFitResult, listing: ListingData, buyer: BuyerData): MatchFitResult {
  const sp = sellerPrice(listing)
  if (sp?.basis !== 'estimate' || (buyer.priceMin == null && buyer.priceMax == null)) return mf
  const chance = fitProbability(sp.price, buyer.priceMin, buyer.priceMax)
  const cap = chance < WARM_MIN_PRICE_CHANCE ? WARM_MIN_FIT - 1 : chance < HOT_MIN_PRICE_CHANCE ? HOT_MIN_FIT - 1 : 100
  return mf.matchFit > cap ? { ...mf, matchFit: cap } : mf
}

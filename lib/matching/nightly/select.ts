import type { MatchFitResult } from '../scorerTypes'
import { HOT_MIN_FIT, WARM_MIN_FIT } from '../tiers'
import { fitReason } from '../fitReason'

// Brief 35: which scored (seller, buyer) pairs the nightly job keeps, and the
// Match row each kept pair becomes. Pure, so it's unit-tested without a DB.
export const MIN_MATCH_FIT = 50
export const TOP_PER_SELLER = 10

export interface Candidate {
  sellerId: string
  buyerId: string
  counterpartType: 'opportunity' | 'mojo'
  matchFit: MatchFitResult
  captureStatus: string
}

export { HOT_MIN_FIT, WARM_MIN_FIT }
export const tierOf = (mf: number): 'HOT' | 'WARM' | 'POSSIBLE' => (mf >= HOT_MIN_FIT ? 'HOT' : mf >= WARM_MIN_FIT ? 'WARM' : 'POSSIBLE')

// Brief 41 (H7): the stored reason is a plain-English line of the fit features
// that raised the match, then any that lowered it (seller-motivation signals are
// never named; nor is price when it's our estimate). It used to be the raw keys
// ("preForeclosure + highEquity + beds"), which reached reports, drafts and the
// CRM's "Why" column.
export const reasonOf = (mf: MatchFitResult): string => fitReason(mf)

// One seller's eligible, undismissed candidates → at most n with matchFit >=
// MIN_MATCH_FIT, best first (ties: buyer id ascending, so runs are stable).
export function topForSeller(candidates: Candidate[], n = TOP_PER_SELLER): Candidate[] {
  return candidates
    .filter(c => c.matchFit.matchFit >= MIN_MATCH_FIT)
    .sort((a, b) => b.matchFit.matchFit - a.matchFit.matchFit || (a.buyerId < b.buyerId ? -1 : a.buyerId > b.buyerId ? 1 : 0))
    .slice(0, n)
}

export function toMatchRow(c: Candidate) {
  return {
    opportunityId: c.sellerId,
    counterpartId: c.buyerId,
    counterpartType: c.counterpartType,
    score: c.matchFit.matchFit,
    tier: tierOf(c.matchFit.matchFit),
    reason: reasonOf(c.matchFit),
    captureStatus: c.captureStatus,
    matchFitConfidence: c.matchFit.matchFitConfidence,
    contributions: c.matchFit.contributions,
    unknownFactors: c.matchFit.unknownFactors,
  }
}

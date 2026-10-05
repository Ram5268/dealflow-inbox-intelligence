import type { MatchFitResult } from '../scorerTypes'

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

export const HOT_MIN_FIT = 80
export const WARM_MIN_FIT = 65
export const tierOf = (mf: number): 'HOT' | 'WARM' | 'POSSIBLE' => (mf >= HOT_MIN_FIT ? 'HOT' : mf >= WARM_MIN_FIT ? 'WARM' : 'POSSIBLE')

// Top-3 contribution keys, strongest first (same as the Brief 32 regen script).
export const reasonOf = (contributions: Record<string, number>): string =>
  Object.entries(contributions).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k).join(' + ')

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
    reason: reasonOf(c.matchFit.contributions),
    captureStatus: c.captureStatus,
    matchFitConfidence: c.matchFit.matchFitConfidence,
    contributions: c.matchFit.contributions,
    unknownFactors: c.matchFit.unknownFactors,
  }
}

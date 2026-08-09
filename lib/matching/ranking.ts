// Brief 7.0 — deterministic ranking. The StreetEasy-Expert source preference is
// enforced HERE, in code — never left to the LLM rubric. This makes "an SE party
// always sorts first among same-tier peers" a testable invariant.
//
// Sort order:
//   1. Tier            (Hot > Warm > Possible)
//   2. Source boost    (streeteasy_expert 100 > mojo 50 > inbox 0), within a tier
//   3. Recency         (newer > older, by days-since-created)
//   4. Deterministic id (final stable tiebreak)
//
// (1) and (2) are folded into rankScore so it's a single monotonic sort key; the
// tier band (1000) dwarfs the max source boost (100), so tier always dominates
// source. (3) and (4) are applied as explicit comparator tiebreaks.
import type { MatchResult, SourceBadge, Tier } from './types'

const TIER_BAND: Record<Exclude<Tier, 'None'>, number> = {
  Hot:      3000,
  Warm:     2000,
  Possible: 1000,
}

export const SOURCE_BOOST: Record<SourceBadge, number> = {
  streeteasy_expert: 100,
  mojo:              50,
  inbox:             0,
}

/** Internal sort key: tier band + hardcoded source boost. Higher sorts first. */
export function rankScoreFor(tier: Exclude<Tier, 'None'>, source: SourceBadge): number {
  return TIER_BAND[tier] + SOURCE_BOOST[source]
}

/** Total order over results. Negative ⇒ a sorts before b. */
export function compareMatches(a: MatchResult, b: MatchResult): number {
  if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore // higher score first
  if (a.recencyDays !== b.recencyDays) return a.recencyDays - b.recencyDays // fewer days = newer = first
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0 // stable id tiebreak
}

export function rankMatches(results: MatchResult[]): MatchResult[] {
  return [...results].sort(compareMatches)
}

export const SORTED_BY_EXPLANATION =
  'tier (Hot>Warm>Possible), then source (StreetEasy Expert > Mojo > inbox), then recency (newer first), then id'

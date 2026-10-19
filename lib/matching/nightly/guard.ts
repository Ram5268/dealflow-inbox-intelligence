import type { SwitchCheck } from '../ourEstimates'

// Brief 47 (PR 1): the nightly scoring's size check (engineering precaution,
// Brief 40 audit M6). On Sep 26 a night saw no buyers, kept nothing, and the
// stale-row delete removed every real seller's matches while the run reported
// success; turning test buyers off at go-live would do the same. So before any
// write the night is refused when it sees 0 sellers or 0 buyers, or would keep
// fewer than half as many real-seller matches as the database holds now, or
// leave fewer than half as many sellers with a match. Exactly half passes.
// It compares sizes, never churn: a normal night can replace many pairs (Brief
// 44's first night with our values changed 41 of the call list's top 50).
// No override for now: a deliberate clear at go-live is a later step.
export const SCORING_REFUSED_ACTION = 'NIGHTLY_SCORING_REFUSED'

export type ScoringRefusalReason = 'no_sellers' | 'no_buyers' | 'matches_shrank' | 'sellers_shrank'

export type ScoringSizes = {
  sellers: number // this night's inputs
  buyers: number
  kept: number // what this night would write
  sellersCovered: number
  existingMatches: number // what the database holds now (EXISTING_MATCH_COUNTS_SQL)
  existingSellersCovered: number
}

// The AuditLog row a refused night writes (CONTRACT.md): counts, codes and booleans only.
export type ScoringRefusalDetails = { reasons: ScoringRefusalReason[] } & ScoringSizes & {
  includeTestBuyers: boolean
  ourEstimates?: SwitchCheck // only on a night the USE_OUR_ESTIMATES switch was on, as in NIGHTLY_SCORING
}

// Pure. Empty: the night may be written.
export function scoringRefusal(s: ScoringSizes): ScoringRefusalReason[] {
  const reasons: ScoringRefusalReason[] = []
  if (s.sellers === 0) reasons.push('no_sellers')
  if (s.buyers === 0) reasons.push('no_buyers')
  if (s.kept * 2 < s.existingMatches) reasons.push('matches_shrank')
  if (s.sellersCovered * 2 < s.existingSellersCovered) reasons.push('sellers_shrank')
  return reasons
}

// Thrown after the refusal row is committed (or, in a dry run, after rolling back).
// The message holds the reason codes only.
export class ScoringRefusedError extends Error {
  constructor(readonly reasons: ScoringRefusalReason[]) {
    super(`scoring refused: ${reasons.join(', ')}`)
    this.name = 'ScoringRefusedError'
  }
}

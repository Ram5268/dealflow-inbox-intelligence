import type { AggregatedContact, AggregatedMatch, RankingFeatureResult } from '../types'

// Summarizes seller-motivation across ALL of a contact's matches. A HOT match
// carrying strong distress (preForeclosure + vacancy + foreclosureUrgency) is a
// "call them today" signal; a WARM match with moderate distress is a nudge.
function distressPct(m: { contributions: Record<string, number> }): number {
  const c = m.contributions
  return (c.preForeclosure ?? 0) + (c.vacancy ?? 0) + (c.foreclosureUrgency ?? 0)
}

export function computeMotivationSummary(c: AggregatedContact): RankingFeatureResult {
  // topMatch is guaranteed in contributingMatches by the builder, but include it
  // defensively and dedupe by id.
  const byId = new Map<string, AggregatedMatch>()
  for (const m of c.contributingMatches) byId.set(m.id, m)
  byId.set(c.topMatch.id, {
    id: c.topMatch.id,
    matchFit: c.topMatch.matchFit,
    captureStatus: c.topMatch.captureStatus,
    contributions: c.topMatch.contributions,
  })
  const matches = [...byId.values()]

  const hotDistress = matches.some(m => m.matchFit >= 80 && distressPct(m) > 25)
  if (hotDistress) return { key: 'motivationSummary', score: 1.0, confidence: 'HIGH' }

  const warmDistress = matches.some(m => m.matchFit >= 65 && distressPct(m) > 15)
  if (warmDistress) return { key: 'motivationSummary', score: 0.7, confidence: 'HIGH' }

  return { key: 'motivationSummary', score: 0.4, confidence: 'HIGH' }
}

// Brief 44 (PR 4): the pure parts of scripts/valuation-switch-preview.ts, which shows what
// turning the USE_OUR_ESTIMATES switch on would change, in counts only: tiers, sellers with
// matches, and the call list's top 50. Nothing here reads or writes a database.
import { tierOf, type Candidate } from './nightly/select'
import type { SwitchCheck } from './ourEstimates'
import { applyHardFilters } from '../ranking/hardFilters'
import { composeCallPriority } from '../ranking/callPriority'
import { computeMatchFitLift } from '../ranking/features/matchFitLift'
import { computeMatchFitConfidenceLift } from '../ranking/features/matchFitConfidenceLift'
import { computeCaptureBonus } from '../ranking/features/captureBonus'
import { computeFreshnessBoost } from '../ranking/features/freshnessBoost'
import { computeCooldownPenalty } from '../ranking/features/cooldownPenalty'
import { computeReachabilityBonus } from '../ranking/features/reachabilityBonus'
import { computeMotivationSummary } from '../ranking/features/motivationSummary'
import type { AggregatedContact, Confidence } from '../ranking/types'

// The contact fields the call list's ranking reads. Not the name or the neighborhood (no
// feature uses them), and the preview passes phone numbers only as present or absent
// (engineering precaution: data minimization).
export interface QueueContact {
  id: string
  phone: string | null
  additionalPhones: string[]
  phoneDncFlags: boolean[]
  phoneTypes: string[]
  lastCalled: Date | null
  lastDialDate: Date | null
  status: string | null
  preForeclosureStatus: string | null
  isVacant: boolean | null
  tags: string[]
  groups: string[]
}

export interface RankedSeller {
  contactId: string
  priorityScore: number
}

const CONFIDENCES: Confidence[] = ['HIGH', 'MEDIUM', 'LOW']
const confidenceOf = (v: string): Confidence => ((CONFIDENCES as string[]).includes(v) ? (v as Confidence) : 'MEDIUM')

// The call list's order as buildCallQueue (lib/ranking/queueBuilder.ts) would rank these
// pairs once the nightly job saved them: the same hard filters, the same seven features,
// best first, ties in the contacts' order. `createdAt` is each pair's Match row date (a
// saved pair keeps its date; a new one is dated tonight). Brief 45's PR E moves
// buildCallQueue's per-contact step into rankContact(); once that merges this should call
// it (ourEstimatesPreview.test.ts checks that the two agree).
export function rankInMemory(contacts: QueueContact[], kept: Candidate[], createdAt: (c: Candidate) => Date, now: Date): RankedSeller[] {
  const bySeller = new Map<string, Candidate[]>()
  for (const c of kept) bySeller.set(c.sellerId, [...(bySeller.get(c.sellerId) ?? []), c])
  const ctx = { now }
  const ranked: RankedSeller[] = []
  for (const c of contacts) {
    const ms = (bySeller.get(c.id) ?? [])
      .map(m => ({
        id: `${m.sellerId}|${m.buyerId}|${m.counterpartType}`,
        matchFit: m.matchFit.matchFit,
        matchFitConfidence: confidenceOf(m.matchFit.matchFitConfidence),
        captureStatus: m.captureStatus ?? 'EXTERNAL_BOTH',
        createdAt: createdAt(m),
        contributions: m.matchFit.contributions ?? {},
      }))
      .sort((a, b) => b.matchFit - a.matchFit)
    const filter = applyHardFilters({
      status: c.status, tags: c.tags, groups: c.groups,
      phones: [c.phone, ...c.additionalPhones], phoneDncFlags: c.phoneDncFlags,
      matchCount: ms.length, allMatchesRental: false,
    })
    if (filter.excluded) continue
    const top = ms[0]
    const agg: AggregatedContact = {
      contactId: c.id,
      contactType: 'mojoContact',
      topMatch: top,
      contributingMatches: ms.slice(0, 5).map(m => ({ id: m.id, matchFit: m.matchFit, captureStatus: m.captureStatus, contributions: m.contributions })),
      contact: {
        id: c.id, fullName: '', phone: c.phone, additionalPhones: c.additionalPhones, phoneDncFlags: c.phoneDncFlags,
        phoneTypes: c.phoneTypes, lastCalled: c.lastCalled, lastDialDate: c.lastDialDate, status: c.status,
        preForeclosureStatus: c.preForeclosureStatus, isVacant: c.isVacant, neighborhood: null, tags: c.tags, groups: c.groups,
      },
    }
    const { priorityScore } = composeCallPriority([
      computeMatchFitLift(agg),
      computeMatchFitConfidenceLift(agg),
      computeCaptureBonus(agg),
      computeFreshnessBoost(agg, ctx),
      computeCooldownPenalty(agg, ctx),
      computeReachabilityBonus(agg),
      computeMotivationSummary(agg),
    ])
    ranked.push({ contactId: c.id, priorityScore })
  }
  return ranked.sort((a, b) => b.priorityScore - a.priorityScore)
}

// Average ranks (1-based), ties sharing their mean rank.
function ranks(v: number[]): number[] {
  const order = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0])
  const out = new Array<number>(v.length)
  for (let i = 0; i < order.length;) {
    let j = i
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++
    for (let k = i; k <= j; k++) out[order[k][1]] = (i + j) / 2 + 1
    i = j + 1
  }
  return out
}

function spearman(x: number[], y: number[]): number | null {
  if (x.length < 2) return null
  const rx = ranks(x)
  const ry = ranks(y)
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length
  const mx = mean(rx)
  const my = mean(ry)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < rx.length; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my)
    sxx += (rx[i] - mx) ** 2
    syy += (ry[i] - my) ** 2
  }
  return sxx === 0 || syy === 0 ? null : Math.round((sxy / Math.sqrt(sxx * syy)) * 1000) / 1000
}

// How the call list's top n changes: how many of today's top n leave it, and Spearman's
// rank correlation between those sellers' places without and with our values (1 = same
// order; a seller who leaves the list entirely counts as last).
export function compareTop(without: string[], withOurs: string[], n = 50): { leaving: number; spearman: number | null } {
  const top = without.slice(0, n)
  const topWith = new Set(withOurs.slice(0, n))
  const placeWith = new Map(withOurs.map((id, i) => [id, i + 1]))
  return {
    leaving: top.filter(id => !topWith.has(id)).length,
    spearman: spearman(top.map((_, i) => i + 1), top.map(id => placeWith.get(id) ?? withOurs.length + 1)),
  }
}

export function tierCounts(kept: Array<Pick<Candidate, 'matchFit'>>): Record<'HOT' | 'WARM' | 'POSSIBLE', number> {
  const out = { HOT: 0, WARM: 0, POSSIBLE: 0 }
  for (const k of kept) out[tierOf(k.matchFit.matchFit)]++
  return out
}

export interface PreviewNight {
  kept: Candidate[]
  ineligibleByReason: Record<string, number>
}

// The preview's output: counts only (no seller, buyer, address, phone or value).
export function previewReport(p: {
  includeTestBuyers: boolean
  switchOn: boolean
  sellers: number
  buyers: number
  sellersPricedByOurValue: number
  without: PreviewNight
  withOurs: PreviewNight
  listWithout: RankedSeller[]
  listWith: RankedSeller[]
  check: SwitchCheck
}) {
  const side = (n: PreviewNight, list: RankedSeller[]) => ({
    matches: n.kept.length,
    tiers: tierCounts(n.kept),
    sellersCovered: new Set(n.kept.map(k => k.sellerId)).size,
    wrongPrice: n.ineligibleByReason.wrong_price ?? 0,
    callList: list.length,
  })
  return {
    includeTestBuyers: p.includeTestBuyers,
    switchOn: p.switchOn,
    sellers: p.sellers,
    buyers: p.buyers,
    sellersPricedByOurValue: p.sellersPricedByOurValue,
    withoutOurValues: side(p.without, p.listWithout),
    withOurValues: side(p.withOurs, p.listWith),
    top50: compareTop(p.listWithout.map(r => r.contactId), p.listWith.map(r => r.contactId), 50),
    nightlyRollbackCheck: p.check,
  }
}

// Brief 43 PR 6 — two counts Drift can now give exactly, as database counts
// over every match (the NEW MATCHES note Drift gets holds only the top 20).
//   count_matches({ tier })      Q26, M-06: "how many HOT matches do I have?"
//   count_sellers_with_buyers()  S-11; D14 [Ryan, 2026-10-19]: "which of my
//     sellers have buyers waiting?" gets a count, plus "they're ranked in your
//     CRM Queue". A count only, never names: Drift never lists sellers (D11
//     [Ryan, 2026-10-18]). Its own tool rather than a count_matches option, so
//     Drift reaches for it on that question and nothing in it can name a seller.
// A tier is the stored one; a row without one is placed by the tier
// thresholds (lib/matching/tiers.ts), as the morning digest counts them.
// Pairs Ryan dismissed are left out, as /matches leaves them out; showing
// confirmations aren't buyer matches.
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { isTestModeOnly } from '@/lib/config/testMode'
import { inChunks } from '@/lib/matching/dismissals'
import { HOT_MIN_FIT, WARM_MIN_FIT } from '@/lib/matching/tiers'
import { applyHardFilters } from '@/lib/ranking/hardFilters'
import { crmSellerPoolWhere } from '@/lib/chat/crmSellers'
import { tierOf } from '@/lib/chat/sellerMatchesCard'

export const MATCH_TIER_CHOICES = ['HOT', 'WARM', 'POSSIBLE', 'ALL'] as const
export type MatchTierChoice = (typeof MATCH_TIER_CHOICES)[number]

export const countMatchesInputSchema = z.object({
  tier: z.preprocess(v => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.enum(MATCH_TIER_CHOICES).optional()),
})
export type CountMatchesInput = z.input<typeof countMatchesInputSchema>

export function tierWhere(tier: MatchTierChoice | 'HOT_OR_WARM'): Prisma.MatchWhereInput {
  switch (tier) {
    case 'HOT': return { OR: [{ tier: 'HOT' }, { tier: null, score: { gte: HOT_MIN_FIT } }] }
    case 'WARM': return { OR: [{ tier: 'WARM' }, { tier: null, score: { gte: WARM_MIN_FIT, lt: HOT_MIN_FIT } }] }
    case 'POSSIBLE': return { OR: [{ tier: 'POSSIBLE' }, { tier: null, score: { lt: WARM_MIN_FIT } }] }
    case 'HOT_OR_WARM': return { OR: [{ tier: { in: ['HOT', 'WARM'] } }, { tier: null, score: { gte: WARM_MIN_FIT } }] }
    case 'ALL': return {}
  }
}

// A database count, minus the dismissed pairs among those rows. Dismissals are
// few, so only the dismissed pairs' own rows are read (dismissedRows), and none
// at all when nothing is dismissed.
async function countUndismissed(where: Prisma.MatchWhereInput): Promise<{ count: number; unseen: number }> {
  const [count, unseen, dismissals] = await Promise.all([
    prisma.match.count({ where }),
    prisma.match.count({ where: { AND: [where, { seen: false }] } }),
    prisma.matchDismissal.findMany({ select: { partyId: true, listingId: true } }),
  ])
  if (dismissals.length === 0) return { count, unseen }
  const gone = await dismissedRows(where, dismissals)
  return { count: count - gone.length, unseen: unseen - gone.filter(m => !m.seen).length }
}

// The rows of `where` that ARE a dismissed pair, either orientation (as
// loadDismissedPairs reads a dismissal), looked up by the pairs themselves: at
// most a couple of rows per dismissal, never every row of a much-matched buyer.
// 4 bind values per dismissal, so 1,000 per query stays far under Prisma's limit.
const PAIR_CHUNK = 1_000
type Dismissal = { partyId: string; listingId: string }
async function dismissedRows(where: Prisma.MatchWhereInput, dismissals: Dismissal[]) {
  const out = new Map<string, { id: string; opportunityId: string; seen: boolean; tier: string | null; score: number }>()
  for (let i = 0; i < dismissals.length; i += PAIR_CHUNK) {
    const pairs = dismissals.slice(i, i + PAIR_CHUNK).flatMap(d => [
      { opportunityId: d.listingId, counterpartId: d.partyId },
      { opportunityId: d.partyId, counterpartId: d.listingId },
    ])
    const rows = await prisma.match.findMany({
      where: { AND: [where, { OR: pairs }] },
      select: { id: true, opportunityId: true, seen: true, tier: true, score: true },
    })
    for (const r of rows) out.set(r.id, r)
  }
  return [...out.values()]
}

export async function countMatches(rawInput: CountMatchesInput): Promise<{ tier: MatchTierChoice; count: number; unseen: number }> {
  const tier = countMatchesInputSchema.parse(rawInput ?? {}).tier ?? 'ALL'
  const organizationId = await getCurrentOrgId()
  const where: Prisma.MatchWhereInput = {
    AND: [{ organizationId, counterpartType: { not: 'showing_confirmation' } }, tierWhere(tier)],
  }
  return { tier, ...(await countUndismissed(where)) }
}

// Ryan's CRM sellers (find_seller's pool: real CRM sellers, no duplicate,
// removed or legacy copies) with at least one undismissed HOT or WARM buyer,
// and how many of them have a HOT one. Only sellers the call Queue ranks: the
// Queue's own hard filters (lib/ranking/hardFilters.ts: a do-not-call status,
// tag or group, every phone flagged) leave the others out, so "they're ranked
// in your CRM Queue" (D14 [Ryan, 2026-10-19]) stays true [engineering precaution].
export async function countSellersWithBuyers(): Promise<{ count: number; withHot: number }> {
  // TEST_MODE_ONLY: CRM sellers are real data, so test mode counts none (as count_sellers).
  if (isTestModeOnly()) return { count: 0, withHot: 0 }
  const organizationId = await getCurrentOrgId()
  const seller = { organizationId, opportunityType: 'contact' }
  const hotOrWarm: Prisma.MatchWhereInput = { AND: [seller, tierWhere('HOT_OR_WARM')] }
  // Database group-bys: one row per seller (at most the ~1,500 sellers), not every match.
  const [byHotOrWarm, byHot, dismissals] = await Promise.all([
    prisma.match.groupBy({ by: ['opportunityId'], where: hotOrWarm, _count: { _all: true } }),
    prisma.match.groupBy({ by: ['opportunityId'], where: { AND: [seller, tierWhere('HOT')] }, _count: { _all: true } }),
    prisma.matchDismissal.findMany({ select: { partyId: true, listingId: true } }),
  ])
  if (byHotOrWarm.length === 0) return { count: 0, withHot: 0 }
  const left = new Map(byHotOrWarm.map(g => [g.opportunityId, g._count._all]))
  const leftHot = new Map(byHot.map(g => [g.opportunityId, g._count._all]))
  for (const m of dismissals.length > 0 ? await dismissedRows(hotOrWarm, dismissals) : []) {
    left.set(m.opportunityId, (left.get(m.opportunityId) ?? 0) - 1)
    if (tierOf(m) === 'HOT') leftHot.set(m.opportunityId, (leftHot.get(m.opportunityId) ?? 0) - 1)
  }
  const waiting = [...left].filter(([, n]) => n > 0).map(([id]) => id)
  const inPool = new Set((await inChunks(waiting, chunk => prisma.mojoContact.findMany({
    where: { AND: [crmSellerPoolWhere(organizationId), { id: { in: chunk } }] },
    select: { id: true, status: true, tags: true, groups: true, phone: true, additionalPhones: true, phoneDncFlags: true, metadata: true },
  })))
    // As rankContact calls it (lib/ranking/queueBuilder.ts); these sellers have matches.
    .filter(c => !applyHardFilters({
      status: c.status, tags: c.tags ?? [], groups: c.groups ?? [],
      phones: [c.phone, ...(c.additionalPhones ?? [])], phoneDncFlags: c.phoneDncFlags ?? [],
      matchCount: 1, allMatchesRental: false,
    }).excluded)
    // The CRM Queue also drops a lead on the CRM's own opt-out list (its
    // compliance scrub; DealFlow keeps the mark as metadata.crmOptOut, PR 5) and
    // a lead with no phone, so those aren't "ranked in your CRM Queue" either
    // [engineering precaution].
    .filter(c => (c.metadata as { crmOptOut?: unknown } | null)?.crmOptOut !== true && [c.phone, ...(c.additionalPhones ?? [])].some(Boolean))
    .map(c => c.id))
  let count = 0
  let withHot = 0
  for (const id of waiting) {
    if (!inPool.has(id)) continue
    count++
    if ((leftHot.get(id) ?? 0) > 0) withHot++
  }
  return { count, withHot }
}

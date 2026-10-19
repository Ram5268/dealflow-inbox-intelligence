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
import { inChunks, loadDismissedPairs } from '@/lib/matching/dismissals'
import { HOT_MIN_FIT, WARM_MIN_FIT } from '@/lib/matching/tiers'
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
// few, so only rows that touch a dismissed id are read, and none at all when
// nothing is dismissed.
async function countUndismissed(where: Prisma.MatchWhereInput): Promise<{ count: number; unseen: number }> {
  const [count, unseen, dismissals] = await Promise.all([
    prisma.match.count({ where }),
    prisma.match.count({ where: { AND: [where, { seen: false }] } }),
    prisma.matchDismissal.findMany({ select: { partyId: true, listingId: true } }),
  ])
  if (dismissals.length === 0) return { count, unseen }
  const ids = [...new Set(dismissals.flatMap(d => [d.partyId, d.listingId]))]
  const touched = new Map((await inChunks(ids, chunk => prisma.match.findMany({
    where: { AND: [where, { OR: [{ opportunityId: { in: chunk } }, { counterpartId: { in: chunk } }] }] },
    select: { id: true, opportunityId: true, counterpartId: true, seen: true },
  }))).map(m => [m.id, m]))
  const isDismissed = await loadDismissedPairs(prisma, [...touched.values()])
  let gone = 0
  let goneUnseen = 0
  for (const m of touched.values()) {
    if (!isDismissed(m)) continue
    gone++
    if (!m.seen) goneUnseen++
  }
  return { count: count - gone, unseen: unseen - goneUnseen }
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
// and how many of them have a HOT one.
export async function countSellersWithBuyers(): Promise<{ count: number; withHot: number }> {
  // TEST_MODE_ONLY: CRM sellers are real data, so test mode counts none (as count_sellers).
  if (isTestModeOnly()) return { count: 0, withHot: 0 }
  const organizationId = await getCurrentOrgId()
  const rows = await prisma.match.findMany({
    where: { AND: [{ organizationId, opportunityType: 'contact' }, tierWhere('HOT_OR_WARM')] },
    select: { opportunityId: true, counterpartId: true, tier: true, score: true },
  })
  if (rows.length === 0) return { count: 0, withHot: 0 }
  const isDismissed = await loadDismissedPairs(prisma, rows)
  const hot = new Map<string, boolean>()
  for (const m of rows) {
    if (isDismissed(m)) continue
    hot.set(m.opportunityId, hot.get(m.opportunityId) === true || tierOf(m) === 'HOT')
  }
  const inPool = new Set((await inChunks([...hot.keys()], chunk => prisma.mojoContact.findMany({
    where: { AND: [crmSellerPoolWhere(organizationId), { id: { in: chunk } }] },
    select: { id: true },
  }))).map(c => c.id))
  let count = 0
  let withHot = 0
  for (const [id, isHot] of hot) {
    if (!inPool.has(id)) continue
    count++
    if (isHot) withHot++
  }
  return { count, withHot }
}

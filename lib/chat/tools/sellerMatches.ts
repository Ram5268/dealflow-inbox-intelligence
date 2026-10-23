// Brief 43 PR 6 — get_seller_matches (N1, M-01; D11 [Ryan, 2026-10-18], by
// address D13 [Ryan, 2026-10-19]): "which buyers match [one of my sellers]?"
//
// ONE seller, found with find_seller's own lookup (Brief 43 PR 5: by name or
// street address, over every seller with no 500 cap; 88 is never 188). Several
// with that name give the same up-to-3 candidates to ask which; none is none.
// Then that seller's buyers, the same ones /matches and the CRM card show:
//   - the rows: the seller's own Match rows (the seller as the supply side, the
//     rows the nightly writes), minus any pair Ryan dismissed (either
//     orientation, as /matches and the call list leave them out);
//   - the order: /api/matches's (best score first, then newest), with a tie
//     broken by the seller's call-list entry, the list the CRM card's buyers
//     come from (CallQueueEntry primary + contributing matches, best score
//     first, ties in the entry's order: the CRM's BUYERS_SQL, copied in
//     lib/importScoring/signals.ts). So the first five are the CRM card's five,
//     in its order, once the morning CRM sync has copied that night's list.
//   - the tier: the stored one (lib/matching/tiers.ts thresholds for rows
//     without one), and the homeowner-safe fit line /api/matches shows.
// /api/matches also lists matches Ryan hasn't opened first. That flag is about
// the Matches page, not the buyer, and the CRM card ignores it, so it doesn't
// reorder a seller's buyers here [engineering precaution].
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { loadDismissedPairs } from '@/lib/matching/dismissals'
import { plainFitReason } from '@/lib/matching/fitReason'
import {
  buyerWants, matchLink, tierOf, type BuyerFacts, type SellerMatchBuyer, type SellerMatches, type SellerMatchesSeller,
} from '@/lib/chat/sellerMatchesCard'
import type { SellerCandidate, SellerCard } from '@/lib/chat/sellerCard'
import { findSeller, type FindSellerInput } from './findSeller'

// The nightly keeps at most 10 buyers per seller (lib/matching/nightly/select.ts
// TOP_PER_SELLER), so this is all of them on a normal night.
export const MAX_BUYERS_SHOWN = 10

// The same input as find_seller: { name?, address?, neighborhood? } (the
// neighborhood picks one of several same-name sellers, Brief 43 PR 5).
export type GetSellerMatchesInput = FindSellerInput

export type GetSellerMatchesResult =
  | SellerMatches
  | { candidates: SellerCandidate[] }
  | { none: true }

export async function getSellerMatches(rawInput: GetSellerMatchesInput): Promise<GetSellerMatchesResult> {
  // find_seller parses the input, and in test mode reaches no CRM seller.
  const found = await findSeller(rawInput)
  if (!('match' in found)) return found
  return loadSellerMatches(await getCurrentOrgId(), sellerOf(found.match))
}

// The seller as the matches result carries it (no phone, no CRM link).
export function sellerOf(card: SellerCard): SellerMatchesSeller {
  const { id, name, address, neighborhood, doNotContact } = card
  return { kind: 'crm_seller', id, name, address, neighborhood, doNotContact }
}

const MATCH_SELECT = {
  id: true, score: true, tier: true, reason: true, createdAt: true,
  opportunityId: true, counterpartId: true, counterpartType: true,
} as const satisfies Prisma.MatchSelect
type MatchRow = Prisma.MatchGetPayload<{ select: typeof MATCH_SELECT }>

export async function loadSellerMatches(organizationId: string, seller: SellerMatchesSeller): Promise<SellerMatches> {
  const rows = await prisma.match.findMany({
    where: { organizationId, opportunityType: 'contact', opportunityId: seller.id },
    select: MATCH_SELECT,
  })
  const isDismissed = rows.length > 0 ? await loadDismissedPairs(prisma, rows) : () => false
  const kept = rows.filter(m => !isDismissed(m))

  const entry = kept.length > 0
    ? await prisma.callQueueEntry.findFirst({
        where: { organizationId, contactId: seller.id },
        orderBy: { generatedAt: 'desc' },
        select: { primaryMatchId: true, contributingMatchIds: true },
      })
    : null
  const onCallList = new Map(
    [entry?.primaryMatchId, ...(entry?.contributingMatchIds ?? [])].filter((x): x is string => !!x).map((x, i) => [x, i]),
  )
  const listPos = (m: MatchRow) => onCallList.get(m.id) ?? Number.MAX_SAFE_INTEGER
  kept.sort((a, b) =>
    b.score - a.score || listPos(a) - listPos(b) || b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const tiers = { hot: 0, warm: 0, possible: 0 }
  for (const m of kept) {
    const tier = tierOf(m)
    tiers[tier === 'HOT' ? 'hot' : tier === 'WARM' ? 'warm' : 'possible']++
  }

  const shown = kept.slice(0, MAX_BUYERS_SHOWN)
  const facts = await loadBuyerFacts(shown)
  const buyers: SellerMatchBuyer[] = shown.map(m => {
    const f = facts.get(`${m.counterpartType}:${m.counterpartId}`)
    return {
      matchId: m.id,
      tier: tierOf(m),
      score: m.score,
      wants: buyerWants(f ?? NO_FACTS),
      // The seller is a homeowner, so the line never names price (Brief 41 H7).
      fit: plainFitReason(m.reason, { homeowner: true }),
      isTestData: f?.isTestData ?? false,
      matchesUrl: matchLink(m.id),
    }
  })
  return { seller, count: kept.length, tiers, buyers, matchesUrl: buyers[0]?.matchesUrl ?? null }
}

const NO_FACTS: BuyerFacts = { neighborhoods: [], propertyTypes: [], bedsMin: null, bedsMax: null, priceMin: null, priceMax: null, buyerArchetype: null }
const nonEmpty = (xs: Array<string | null | undefined>) => xs.filter((x): x is string => typeof x === 'string' && x.trim() !== '')

// The buyer side of each match, field for field as BUYERS_SQL reads it: an
// inbox request (ExtractedOpportunity) or a buyer in Ryan's CRM table
// (MojoContact). Reads no name, phone or email of any kind.
async function loadBuyerFacts(rows: MatchRow[]): Promise<Map<string, BuyerFacts & { isTestData: boolean }>> {
  const oppIds = rows.filter(m => m.counterpartType === 'opportunity').map(m => m.counterpartId)
  const mojoIds = rows.filter(m => m.counterpartType === 'mojo').map(m => m.counterpartId)
  const [opps, mojos] = await Promise.all([
    oppIds.length > 0
      ? prisma.extractedOpportunity.findMany({
          where: { id: { in: oppIds } },
          select: {
            id: true, neighborhood: true, neighborhoods: true, propertyTypes: true, beds: true, minBeds: true, maxBeds: true,
            price: true, minPrice: true, maxPrice: true, buyerArchetype: true, isTestData: true,
          },
        })
      : [],
    mojoIds.length > 0
      ? prisma.mojoContact.findMany({
          where: { id: { in: mojoIds } },
          select: {
            id: true, neighborhood: true, initialNeighborhood: true, bedsMin: true, bedsMax: true,
            budgetMin: true, budgetMax: true, cashOnly: true, isTestData: true,
          },
        })
      : [],
  ])
  const out = new Map<string, BuyerFacts & { isTestData: boolean }>()
  for (const o of opps) {
    out.set(`opportunity:${o.id}`, {
      neighborhoods: o.neighborhoods.length > 0 ? o.neighborhoods : nonEmpty([o.neighborhood]),
      propertyTypes: o.propertyTypes ?? [],
      bedsMin: o.minBeds ?? o.beds, bedsMax: o.maxBeds ?? o.beds,
      priceMin: o.minPrice ?? o.price, priceMax: o.maxPrice ?? o.price,
      buyerArchetype: o.buyerArchetype, isTestData: o.isTestData,
    })
  }
  for (const c of mojos) {
    out.set(`mojo:${c.id}`, {
      neighborhoods: nonEmpty([c.neighborhood, c.initialNeighborhood]).slice(0, 1),
      propertyTypes: [],
      bedsMin: c.bedsMin, bedsMax: c.bedsMax, priceMin: c.budgetMin, priceMax: c.budgetMax,
      buyerArchetype: c.cashOnly ? 'CASH_BUYER' : null, isTestData: c.isTestData,
    })
  }
  return out
}

// What Drift reads back: the counts and each buyer's line, without the links
// or match ids (the page shows each buyer's "Open in Matches" link). A URL
// Drift copied into its text would trip the guard's external_url check and end
// in the stock reply (Q19) [engineering precaution].
export function getSellerMatchesForModel(result: GetSellerMatchesResult): unknown {
  if (!('seller' in result)) return result
  return {
    seller: result.seller,
    count: result.count,
    tiers: result.tiers,
    buyers: result.buyers.map(b => ({ tier: b.tier, score: b.score, wants: b.wants, fit: b.fit, ...(b.isTestData ? { testBuyer: true } : {}) })),
    ...(result.count > result.buyers.length ? { listed: `the top ${result.buyers.length} of ${result.count}` } : {}),
    shownToRyanAs: result.count > 0
      ? 'a card listing these buyers in this order, each with an Open in Matches link'
      : 'nothing: this seller has no matching buyers yet',
  }
}

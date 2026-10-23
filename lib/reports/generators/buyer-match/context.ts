// Brief 27.0 — shared context for the Buyer Match generator.
//
// The buyer is a demand-side ExtractedOpportunity (BUYER_ISO or RENTER_INQUIRY):
// that is what the matcher tiers and what the persisted Match rows reference as
// `counterpartId`. gatherContext loads the buyer eagerly (every section needs it)
// and exposes a memoized, lazy `matches()` so fragment sections that don't touch
// matches (e.g. criteria) never run the join.
//
// Brief 48 PR 13 (Q8): the buyer may also be one stored in Ryan's CRM table (a
// MojoContact with intent BUYER or RENTER). Nightly matching already uses those
// as demand, writing their Match rows with counterpartType 'mojo', and Drift's
// search_parties returns them (Brief 43 PR 5), but a report for one failed
// "not found".
// Brief 48 PR 13 (M29): a match Ryan dismissed stays out of the report, as it
// does on /matches.
// Brief 48 PR 13 (Q44): every read is scoped to one organization: the one the
// caller passes (POST /api/reports), else the buyer's own (Drift's report tool,
// whose buyer ids come from organization-scoped searches) [engineering precaution].
import { Category } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import type { GenContext, BuyerRecord, MatchedListing } from '../types'
import { resolveSupplies } from '../../../matching/supplyResolver'
import { buyerFacingSupply } from '../../../buyerFacingSupply'
import { loadDismissedPairs } from '../../../matching/dismissals'
import { isTestModeOnly } from '../../../config/testMode'

const BUYER_SELECT = {
  id: true, organizationId: true, category: true, extractedTitle: true, neighborhoods: true, neighborhood: true,
  borough: true, minBeds: true, maxBeds: true, beds: true, minPrice: true, maxPrice: true,
  price: true, mustHaves: true, dealbreakers: true, timeline: true, propertyTypes: true,
  isTestData: true, createdAt: true,
} as const

// A CRM buyer's criteria, as nightly matching reads them (lib/matching/adapters.ts
// mojoContactToBuyerData). Never its notes, phone or email: the notes are call
// notes, not criteria, and nothing about how to reach them belongs in a report
// [engineering precaution].
const CRM_BUYER_SELECT = {
  id: true, organizationId: true, intent: true, fullName: true, neighborhood: true, initialNeighborhood: true,
  bedsMin: true, bedsMax: true, budgetMin: true, budgetMax: true, timing: true, isTestData: true, createdAt: true,
} as const

const notFound = (buyerId: string) => new Error(`buyer-match: buyer ${buyerId} not found`)

type Loaded = { buyer: BuyerRecord; organizationId: string; counterpartType: 'opportunity' | 'mojo' }

async function loadEmailBuyer(prisma: PrismaClient, buyerId: string): Promise<Loaded | null> {
  const row = await prisma.extractedOpportunity.findUnique({
    where: { id: buyerId },
    select: BUYER_SELECT,
  })
  if (!row) return null
  if (row.category !== Category.BUYER_ISO && row.category !== Category.RENTER_INQUIRY) {
    throw new Error(
      `buyer-match: ${buyerId} is category ${row.category}, not a demand party (BUYER_ISO / RENTER_INQUIRY). ` +
      `Pass a buyer/renter ISO opportunity id.`,
    )
  }

  const hoods = row.neighborhoods.length ? row.neighborhoods : row.neighborhood ? [row.neighborhood] : []
  const buyer: BuyerRecord = {
    id: row.id,
    category: row.category,
    name: row.extractedTitle,
    neighborhoods: hoods,
    borough: row.borough,
    minBeds: row.minBeds,
    maxBeds: row.maxBeds,
    beds: row.beds,
    minPrice: row.minPrice,
    maxPrice: row.maxPrice,
    price: row.price,
    mustHaves: row.mustHaves,
    dealbreakers: row.dealbreakers,
    timeline: row.timeline,
    propertyTypes: row.propertyTypes,
    isTestData: row.isTestData,
    createdAt: row.createdAt,
  }
  return { buyer, organizationId: row.organizationId, counterpartType: 'opportunity' }
}

async function loadCrmBuyer(prisma: PrismaClient, buyerId: string): Promise<Loaded | null> {
  const row = await prisma.mojoContact.findUnique({ where: { id: buyerId }, select: CRM_BUYER_SELECT })
  if (!row) return null
  // Brief 5.0's test mode never reads a real CRM contact.
  if (isTestModeOnly() && !row.isTestData) return null
  if (row.intent !== 'BUYER' && row.intent !== 'RENTER') {
    // The id and kind only: never a seller's name in an error Drift or the page reads.
    throw new Error(`buyer-match: ${buyerId} is a CRM contact that is not a buyer or renter. Pass a buyer or renter id.`)
  }
  const renter = row.intent === 'RENTER'
  const hood = row.neighborhood ?? row.initialNeighborhood
  const buyer: BuyerRecord = {
    id: row.id,
    category: renter ? Category.RENTER_INQUIRY : Category.BUYER_ISO,
    name: row.fullName?.trim() || `CRM ${renter ? 'renter' : 'buyer'}${hood ? ` in ${hood}` : ''}`,
    neighborhoods: hood ? [hood] : [],
    borough: null,
    minBeds: row.bedsMin,
    maxBeds: row.bedsMax,
    beds: null,
    minPrice: row.budgetMin,
    maxPrice: row.budgetMax,
    price: null,
    mustHaves: null,
    dealbreakers: null,
    timeline: row.timing,
    propertyTypes: [],
    isTestData: row.isTestData,
    createdAt: row.createdAt,
  }
  return { buyer, organizationId: row.organizationId, counterpartType: 'mojo' }
}

export async function gatherContext({
  buyerId,
  prisma,
  organizationId,
}: {
  buyerId: string
  prisma: PrismaClient
  organizationId?: string
}): Promise<GenContext> {
  const loaded = (await loadEmailBuyer(prisma, buyerId)) ?? (await loadCrmBuyer(prisma, buyerId))
  if (!loaded || (organizationId && loaded.organizationId !== organizationId)) throw notFound(buyerId)
  const { buyer, counterpartType } = loaded
  const orgId = organizationId ?? loaded.organizationId

  // Memoized match loader — the persisted Match rows are the matcher's output.
  let cache: MatchedListing[] | null = null
  const matches = async (): Promise<MatchedListing[]> => {
    if (cache) return cache
    const stored = await prisma.match.findMany({
      where: { organizationId: orgId, counterpartId: buyerId, counterpartType },
      orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true, tier: true, score: true, reason: true,
        opportunityId: true, opportunityType: true,
      },
    })
    // Either way round, as /matches/parties and Drift's seller matches read them.
    const pairs = stored.map(m => ({ opportunityId: m.opportunityId, counterpartId: buyerId }))
    const isDismissed = pairs.length > 0 ? await loadDismissedPairs(prisma, pairs) : () => false
    const rows = stored.filter((_, i) => !isDismissed(pairs[i]))
    // Brief 32 — the supply (listing) side may be an ExtractedOpportunity or a
    // MojoContact seller; resolve both via the shared helper. Rows whose supply
    // record is missing (deleted opp/contact) are dropped.
    const supplies = await resolveSupplies(prisma, rows)
    cache = rows.flatMap(m => {
      const found = supplies.get(m.opportunityId)
      if (!found) return []
      // Ryan's decision, 2026-10-17: saved seller notes may keep these details.
      // Buyer-facing text still never names motivation (engineering precaution,
      // Brief 41 H7): a lead or a client conversation here (an old or odd row;
      // no matcher writes one) is shown exactly like a homeowner. Brief 43 PR 3b
      // [Ryan, 2026-10-19]: a homeowner's row carries no street address until
      // they have agreed to sell (the ryan_listing tag); its title is area and type.
      const s = buyerFacingSupply(found)
      return [{
        matchId: m.id,
        tier: m.tier,
        score: m.score,
        reason: m.reason,
        listing: {
          id: s.id,
          category: s.category,
          address: s.address,
          neighborhood: s.neighborhood,
          borough: s.borough,
          price: s.price,
          beds: s.beds,
          squareFeet: s.squareFeet,
          extractedTitle: s.extractedTitle,
          sourceBrokerage: s.sourceBrokerage,
          sourceAgentName: s.sourceAgentName,
          availabilityDate: s.availabilityDate,
          isHomeowner: s.opportunityType === 'contact',
        },
      }]
    })
    return cache
  }

  return { buyerId, prisma, buyer, matches, organizationId: orgId }
}

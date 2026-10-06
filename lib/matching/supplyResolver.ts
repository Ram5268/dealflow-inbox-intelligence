// Brief 32 — resolve the SUPPLY (listing) side of a Match row.
//
// Before Brief 32 the supply side was always an ExtractedOpportunity, reachable
// via the `Match.opportunity` relation. Brief 32 dropped that FK so a MojoContact
// SELLER can also be the supply (opportunityType='contact'). Every consumer that
// used to `include: { opportunity }` now resolves through this helper, which
// batch-loads from the correct table and returns a uniform ResolvedSupply.
//
// Invariant (pre-Brief-32, still true for live data): opportunityType defaults to
// 'opportunity'. Only [TEST_32] seed regen writes 'contact'. A contact supply has
// no Category (category=null) — it is a seller lead, not a classified email.
import { Category } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { fromRaw, getBorough } from '../domain/Neighborhood'
import { homeownerTitle } from './fitReason'

export interface ResolvedSupply {
  id: string
  opportunityType: string // 'opportunity' | 'contact'
  category: Category | null // null for contact supply (no email classification)
  address: string | null
  neighborhood: string | null
  borough: string | null
  // A real asking price only. Brief 41 (H7): a homeowner (contact) has none;
  // our estimate is NOT a price and lives in estimatedValue (internal only).
  price: number | null
  estimatedValue: number | null
  minPrice: number | null
  maxPrice: number | null
  beds: number | null
  squareFeet: number | null
  extractedTitle: string
  sourceBrokerage: string | null
  sourceAgentName: string | null
  availabilityDate: string | null
}

interface MatchRef {
  opportunityId: string
  opportunityType: string
}

// Resolve a batch of Match rows' supply sides in two queries (one per table).
// Returns a Map keyed by opportunityId. Callers look up supplies.get(m.opportunityId).
export async function resolveSupplies(
  prisma: Pick<PrismaClient, 'extractedOpportunity' | 'mojoContact'>,
  rows: MatchRef[],
): Promise<Map<string, ResolvedSupply>> {
  const oppIds = [...new Set(rows.filter(r => r.opportunityType !== 'contact').map(r => r.opportunityId))]
  const contactIds = [...new Set(rows.filter(r => r.opportunityType === 'contact').map(r => r.opportunityId))]

  const out = new Map<string, ResolvedSupply>()

  if (oppIds.length) {
    const opps = await prisma.extractedOpportunity.findMany({
      where: { id: { in: oppIds } },
      select: {
        id: true, category: true, address: true, neighborhood: true, borough: true,
        price: true, minPrice: true, maxPrice: true, beds: true, squareFeet: true,
        extractedTitle: true, sourceBrokerage: true, sourceAgentName: true, availabilityDate: true,
      },
    })
    for (const o of opps) {
      out.set(o.id, {
        id: o.id,
        opportunityType: 'opportunity',
        category: o.category,
        address: o.address,
        neighborhood: o.neighborhood,
        borough: o.borough,
        price: o.price,
        estimatedValue: null,
        minPrice: o.minPrice,
        maxPrice: o.maxPrice,
        beds: o.beds,
        squareFeet: o.squareFeet,
        extractedTitle: o.extractedTitle,
        sourceBrokerage: o.sourceBrokerage,
        sourceAgentName: o.sourceAgentName,
        availabilityDate: o.availabilityDate,
      })
    }
  }

  if (contactIds.length) {
    const contacts = await prisma.mojoContact.findMany({
      where: { id: { in: contactIds } },
      select: {
        id: true, address: true, neighborhood: true, estimatedValue: true,
        propertyBeds: true, buildingSqft: true, priorListingBrokerage: true,
      },
    })
    for (const c of contacts) {
      const canon = fromRaw(c.neighborhood)
      out.set(c.id, {
        id: c.id,
        opportunityType: 'contact',
        category: null,
        address: c.address,
        neighborhood: c.neighborhood,
        borough: canon ? getBorough(canon) : null,
        price: null, // Brief 41 (H7): our estimate is never a price (internal only, below)
        estimatedValue: c.estimatedValue,
        minPrice: null,
        maxPrice: null,
        beds: c.propertyBeds,
        squareFeet: c.buildingSqft,
        extractedTitle: homeownerTitle(c.address, c.neighborhood), // never the homeowner's name (Brief 41)
        sourceBrokerage: c.priorListingBrokerage,
        sourceAgentName: null,
        availabilityDate: null,
      })
    }
  }

  return out
}

// Convenience for single-row consumers (dismiss / schedule / draft routes that
// fetch one Match by id). Returns null if the supply record can't be found.
export async function resolveSupply(
  prisma: Pick<PrismaClient, 'extractedOpportunity' | 'mojoContact'>,
  opportunityId: string,
  opportunityType: string,
): Promise<ResolvedSupply | null> {
  const map = await resolveSupplies(prisma, [{ opportunityId, opportunityType }])
  return map.get(opportunityId) ?? null
}

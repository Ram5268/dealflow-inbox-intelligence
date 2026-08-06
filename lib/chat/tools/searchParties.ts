// Brief 3.0, Step 1b — search_parties tool.
//
// Direct DB search over the demand + lead side, callable by Haiku in the chat
// tool_use loop. Two sources, unified into one card shape:
//   - ExtractedOpportunity BUYER_ISO / RENTER_INQUIRY  -> other agents' buyers/renters
//     (co-broke demand from Ryan's inbox)
//   - MojoContact                                       -> Ryan's personal seller/landlord
//     leads (real property owners he's prospecting; always real data)
//
// role narrows the source: buyer -> BUYER_ISO, renter -> RENTER_INQUIRY,
// seller/landlord -> MojoContact. No role -> all three.
//
// Borough is derived from neighborhood (getBorough(fromRaw(...))) for the same
// null-column reason as search_listings. priceRangeOverlaps ("who's looking in
// this price range?") reuses priceOverlapScore against each party's budget.
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { Category, Prisma } from '@prisma/client'
import { fromRaw, getBorough } from '@/lib/domain/Neighborhood'
import { priceOverlapScore } from '@/lib/matching/priceOverlap'
import { isTestModeOnly } from '@/lib/config/testMode'

export const searchPartiesInputSchema = z.object({
  role: z.enum(['buyer', 'renter', 'seller', 'landlord']).optional(),
  borough: z.string().optional(),
  neighborhoods: z.array(z.string()).optional(),
  beds: z.number().optional(),
  bedsMin: z.number().optional(),
  bedsMax: z.number().optional(),
  priceRangeOverlaps: z.object({ min: z.number(), max: z.number() }).optional(),
  includeTestData: z.boolean().optional(),
  limit: z.number().int().positive().max(200).optional(),
})

export type SearchPartiesInput = z.infer<typeof searchPartiesInputSchema>

export interface PartyCard {
  id: string
  kind: 'party'
  role: 'buyer' | 'renter' | 'seller' | 'landlord'
  category: string | null // BUYER_ISO / RENTER_INQUIRY / 'MOJO_LEAD'
  title: string
  name: string | null
  phone: string | null
  neighborhood: string | null
  beds: number | null
  priceRange: [number, number] | null
  priceOverlapScore?: number
  isTestData: boolean
}

export interface SearchPartiesResult {
  cards: PartyCard[]
  totalMatched: number
  filtersApplied: SearchPartiesInput
}

function canon(n: string | null | undefined): string | null {
  if (!n) return null
  return fromRaw(n) ?? n.trim().toLowerCase()
}

// Shared geography gate for both sources.
function geoMatches(
  wantBorough: string | null,
  wantHoods: string[],
  rowBorough: string | null,
  rowHoodStrings: (string | null | undefined)[],
): boolean {
  if (wantBorough) {
    const derived =
      rowBorough ?? (() => {
        for (const h of rowHoodStrings) {
          const b = h ? getBorough(fromRaw(h) ?? '') : null
          if (b) return b
        }
        return null
      })()
    if (!derived || derived.toLowerCase() !== wantBorough.toLowerCase()) return false
  }
  if (wantHoods.length > 0) {
    const rowHoods = new Set<string>()
    for (const h of rowHoodStrings) {
      const c = canon(h)
      if (c) rowHoods.add(c)
    }
    const hit = wantHoods.some(w =>
      rowHoods.has(w) || [...rowHoods].some(r => r.includes(w) || w.includes(r)),
    )
    if (!hit) return false
  }
  return true
}

export async function searchParties(rawInput: SearchPartiesInput): Promise<SearchPartiesResult> {
  const input = searchPartiesInputSchema.parse(rawInput)
  const organizationId = await getCurrentOrgId()

  const limit = input.limit ?? 50
  const includeTestData = input.includeTestData ?? true  // seed-only test mode: default on
  const wantBorough = input.borough ?? null
  const wantHoods = (input.neighborhoods ?? []).map(canon).filter((c): c is string => c != null)
  const range = input.priceRangeOverlaps ?? null

  // Which sources does the requested role touch?
  const wantOppRoles: Array<'buyer' | 'renter'> =
    input.role === 'buyer' ? ['buyer']
    : input.role === 'renter' ? ['renter']
    : input.role == null ? ['buyer', 'renter']
    : [] // seller/landlord -> Mojo only
  const wantMojo = input.role == null || input.role === 'seller' || input.role === 'landlord'

  const cards: PartyCard[] = []

  // ── ExtractedOpportunity demand (BUYER_ISO / RENTER_INQUIRY) ──────────────
  if (wantOppRoles.length > 0) {
    const cats: Category[] = []
    if (wantOppRoles.includes('buyer')) cats.push(Category.BUYER_ISO)
    if (wantOppRoles.includes('renter')) cats.push(Category.RENTER_INQUIRY)

    const where: Prisma.ExtractedOpportunityWhereInput = {
      organizationId,
      category: { in: cats },
      isDuplicate: false,
      processingStatus: 'active',
    }
    if (!includeTestData) where.isTestData = false
    // TEST_MODE_ONLY hard gate: force seed data on the demand side.
    if (isTestModeOnly()) where.isTestData = true
    if (input.beds != null) where.beds = input.beds
    else if (input.bedsMin != null || input.bedsMax != null) {
      where.beds = {
        ...(input.bedsMin != null ? { gte: input.bedsMin } : {}),
        ...(input.bedsMax != null ? { lte: input.bedsMax } : {}),
      }
    }

    const parties = await prisma.extractedOpportunity.findMany({
      where,
      take: 500,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, category: true, extractedTitle: true, neighborhood: true,
        neighborhoods: true, borough: true, beds: true, minPrice: true,
        maxPrice: true, isTestData: true,
      },
    })

    for (const p of parties) {
      if (!geoMatches(wantBorough, wantHoods, p.borough, [p.neighborhood, ...(p.neighborhoods ?? [])])) continue

      let overlap: number | undefined
      if (range) {
        // Party budget midpoint vs the queried range — reuses the listing helper.
        const mid = p.minPrice != null && p.maxPrice != null ? (p.minPrice + p.maxPrice) / 2
          : p.maxPrice ?? p.minPrice
        overlap = priceOverlapScore(mid ?? null, range.min, range.max)
        if (overlap === 0) continue
      }

      cards.push({
        id: p.id,
        kind: 'party',
        role: p.category === Category.BUYER_ISO ? 'buyer' : 'renter',
        category: p.category,
        title: p.extractedTitle,
        name: null,
        phone: null,
        neighborhood: p.neighborhood,
        beds: p.beds,
        priceRange: p.minPrice != null && p.maxPrice != null ? [p.minPrice, p.maxPrice] : null,
        ...(overlap !== undefined ? { priceOverlapScore: overlap } : {}),
        isTestData: p.isTestData,
      })
    }
  }

  // ── Mojo CRM seller/landlord leads (always real data) ─────────────────────
  // TEST_MODE_ONLY hard gate: Mojo is always real data, so skip the entire
  // block when test mode is on. wantMojo stays computed but the query never runs.
  if (wantMojo && !isTestModeOnly()) {
    const leads = await prisma.mojoContact.findMany({
      where: { organizationId },
      take: 500,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true, fullName: true, phone: true, neighborhood: true,
        city: true, address: true,
      },
    })
    for (const m of leads) {
      if (!geoMatches(wantBorough, wantHoods, null, [m.neighborhood, m.city, m.address])) continue
      cards.push({
        id: m.id,
        kind: 'party',
        role: input.role === 'landlord' ? 'landlord' : 'seller',
        category: 'MOJO_LEAD',
        title: `${m.fullName}${m.neighborhood ? ` — ${m.neighborhood}` : m.address ? ` — ${m.address}` : ''}`,
        name: m.fullName,
        phone: m.phone,
        neighborhood: m.neighborhood ?? null,
        beds: null,
        priceRange: null,
        isTestData: false,
      })
    }
  }

  if (range) cards.sort((a, b) => (b.priceOverlapScore ?? 0) - (a.priceOverlapScore ?? 0))

  const totalMatched = cards.length
  return {
    cards: cards.slice(0, limit),
    totalMatched,
    filtersApplied: input,
  }
}

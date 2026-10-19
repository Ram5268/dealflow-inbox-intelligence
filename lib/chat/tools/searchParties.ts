// Brief 3.0, Step 1b — search_parties tool.
//
// Direct DB search over the demand side, callable by Sonnet in the chat
// tool_use loop. Two sources, unified into one card shape:
//   - ExtractedOpportunity BUYER_ISO / RENTER_INQUIRY  -> other agents' buyers/renters
//     (co-broke demand from Ryan's inbox)
//   - MojoContact intent BUYER / RENTER                 -> buyers and renters stored in
//     Ryan's CRM table (Brief 43 PR 5, Q8: buyers, never "sellers")
//
// role narrows the source: buyer -> buyers, renter -> renters, no role -> both.
// Brief 43 PR 5 (D11 [Ryan, 2026-10-18]): Ryan's CRM sellers are never listed or
// searched here. role seller/landlord is still accepted (an old or invented call
// mustn't error) but returns no cards and a note; find_seller gives one named
// seller's contact and count_sellers a count (lib/chat/tools/findSeller.ts).
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
import { wantedHoods } from './neighborhoodMatch'

export const searchPartiesInputSchema = z.object({
  role: z.enum(['buyer', 'renter', 'seller', 'landlord']).optional(),
  borough: z.string().optional(),
  neighborhoods: z.array(z.string()).optional(),
  nearby: z.boolean().optional(), // Brief 43 PR 7 (Q13): add the adjacent areas
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
  category: string | null // BUYER_ISO / RENTER_INQUIRY / 'CRM_BUYER' / 'CRM_RENTER'
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
  note?: string // Brief 43 PR 5: set when a seller/landlord search was asked for
}

// Brief 43 PR 5 (D11 [Ryan, 2026-10-18]): the answer to a seller/landlord search.
export const SELLERS_NOT_SEARCHABLE = "Sellers aren't searchable in chat; name one to look them up."

const bedsText = (min: number | null, max: number | null): string | null =>
  min != null && max != null ? (min === max ? `${min} beds` : `${min} to ${max} beds`)
    : min != null ? `${min}+ beds` : max != null ? `up to ${max} beds` : null

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
    // Brief 43 PR 7 (Q13): exact canonical names, so Williamsburg no longer pulls
    // in East Williamsburg (nor Harlem East Harlem); nearby adds adjacent areas.
    if (!wantHoods.some(w => rowHoods.has(w))) return false
  }
  return true
}

// Bed-count overlap between a query (exact OR min/max range) and a row that
// may store its beds as either a scalar (`beds`) or a range (`minBeds`/`maxBeds`).
// ISO buyers routinely store as range with scalar null; treating scalar-only would
// drop the majority of legitimate buyer ISOs. Exported for unit testing.
export function bedsMatches(
  wantExact: number | null,
  wantMin: number | null,
  wantMax: number | null,
  rowBeds: number | null,
  rowMinBeds: number | null,
  rowMaxBeds: number | null,
): boolean {
  // Nothing wanted → don't gate.
  if (wantExact == null && wantMin == null && wantMax == null) return true

  // Row effective range: prefer scalar when set, else fall back to min/max.
  const rLoRaw = rowBeds ?? rowMinBeds
  const rHiRaw = rowBeds ?? rowMaxBeds

  // Row is fully unknown → neutral, don't exclude (mirrors geoMatches: a null
  // dimension doesn't gate out a partially-extracted row).
  if (rLoRaw == null && rHiRaw == null) return true

  const rLo = rLoRaw ?? rHiRaw ?? 0
  const rHi = rHiRaw ?? rLoRaw ?? Number.POSITIVE_INFINITY

  if (wantExact != null) {
    return rLo <= wantExact && wantExact <= rHi
  }
  const qLo = wantMin ?? 0
  const qHi = wantMax ?? Number.POSITIVE_INFINITY
  return rLo <= qHi && qLo <= rHi
}

// Brief 43 PR 7 (Q10): does a party's budget fit the asked price (or range)?
// Scores the asked price nearest the budget against the budget itself, so a
// $1.0M-$2.0M buyer is a full fit for $1.8M and a max-only $2.0M buyer too (the
// old test compared the budget's midpoint). Up to 5% past the budget is a near
// fit (priceOverlapScore's default tolerance); no budget at all is no fit.
export function budgetOverlap(range: { min: number; max: number }, budgetMin: number | null, budgetMax: number | null): number {
  const lo = Math.min(range.min, range.max), hi = Math.max(range.min, range.max)
  const asked = hi < (budgetMin ?? 0) ? hi : lo > (budgetMax ?? Number.POSITIVE_INFINITY) ? lo : Math.max(lo, budgetMin ?? 0)
  return priceOverlapScore(asked, budgetMin, budgetMax)
}

export async function searchParties(rawInput: SearchPartiesInput): Promise<SearchPartiesResult> {
  const input = searchPartiesInputSchema.parse(rawInput)
  const organizationId = await getCurrentOrgId()

  const limit = input.limit ?? 50
  const includeTestData = input.includeTestData ?? true  // seed-only test mode: default on
  const wantBorough = input.borough ?? null
  const wantHoods = wantedHoods(input.neighborhoods, input.nearby)
  const range = input.priceRangeOverlaps ?? null

  // Brief 43 PR 5 (D11 [Ryan, 2026-10-18]): no seller or landlord lists.
  if (input.role === 'seller' || input.role === 'landlord') {
    return { cards: [], totalMatched: 0, filtersApplied: input, note: SELLERS_NOT_SEARCHABLE }
  }

  // Which sides does the requested role touch?
  const wantOppRoles: Array<'buyer' | 'renter'> =
    input.role === 'buyer' ? ['buyer']
    : input.role === 'renter' ? ['renter']
    : ['buyer', 'renter']

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
      // Brief 6.3 — a comp-derived party is not a live lead; keep it out of the pool.
      // NULL-SAFE: the bare `{ not: 'comp_reference' }` DROPS null-provenance rows
      // under Prisma 7.8 + @prisma/adapter-pg (SQL `<>` is NULL for null rows), which
      // would exclude every normal direct-extraction lead. The OR keeps null +
      // buried_recovery, excludes only comp_reference. (6.3 hotfix; proven by probe.)
      OR: [{ provenance: null }, { provenance: { not: 'comp_reference' } }],
    }
    if (!includeTestData) where.isTestData = false
    // TEST_MODE_ONLY hard gate: force seed data on the demand side.
    if (isTestModeOnly()) where.isTestData = true
    // Beds are NOT gated at the Prisma layer: buyer ISOs store their bed criteria
    // as minBeds/maxBeds with the scalar `beds` column null (~90% of rows — this is
    // correct extractor behavior: ISOs are ranges, not scalars). A `where.beds`
    // filter against the scalar column drops all of them. Filtered in-memory below
    // via bedsMatches, which reads both the scalar and the range. (Brief 30.1)

    const parties = await prisma.extractedOpportunity.findMany({
      where,
      take: 500,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, category: true, extractedTitle: true, neighborhood: true,
        neighborhoods: true, borough: true, beds: true, minBeds: true,
        maxBeds: true, minPrice: true, maxPrice: true, isTestData: true,
      },
    })

    for (const p of parties) {
      if (!geoMatches(wantBorough, wantHoods, p.borough, [p.neighborhood, ...(p.neighborhoods ?? [])])) continue
      if (!bedsMatches(input.beds ?? null, input.bedsMin ?? null, input.bedsMax ?? null, p.beds, p.minBeds, p.maxBeds)) continue

      let overlap: number | undefined
      if (range) {
        overlap = budgetOverlap(range, p.minPrice, p.maxPrice)
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

  // ── Buyers and renters stored in Ryan's CRM table (MojoContact intent BUYER/RENTER) ──
  // Brief 43 PR 5 (Q8): nightly matching already uses them as demand
  // (lib/matching/adapters.ts mojoContactToBuyerData: neighborhood or
  // initialNeighborhood, budgetMin/Max, bedsMin/Max). Same test-data rules as the
  // inbox side above. No phone on the card: Ryan asked about demand, and this
  // keeps contact details to the one seller he names (D11) [engineering precaution].
  const intents = wantOppRoles.map(r => (r === 'buyer' ? 'BUYER' : 'RENTER'))
  const crmWhere: Prisma.MojoContactWhereInput = { organizationId, intent: { in: intents } }
  if (!includeTestData) crmWhere.isTestData = false
  if (isTestModeOnly()) crmWhere.isTestData = true
  const crmParties = await prisma.mojoContact.findMany({
    where: crmWhere,
    take: 500,
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true, fullName: true, intent: true, neighborhood: true, initialNeighborhood: true, city: true,
      bedsMin: true, bedsMax: true, budgetMin: true, budgetMax: true, isTestData: true,
    },
  })
  for (const m of crmParties) {
    const hood = m.neighborhood ?? m.initialNeighborhood ?? null
    if (!geoMatches(wantBorough, wantHoods, null, [hood, m.city])) continue
    if (!bedsMatches(input.beds ?? null, input.bedsMin ?? null, input.bedsMax ?? null, null, m.bedsMin, m.bedsMax)) continue

    let overlap: number | undefined
    if (range) {
      // Same budget test as the inbox side above.
      const mid = m.budgetMin != null && m.budgetMax != null ? (m.budgetMin + m.budgetMax) / 2
        : m.budgetMax ?? m.budgetMin
      overlap = priceOverlapScore(mid ?? null, range.min, range.max)
      if (overlap === 0) continue
    }

    const role = m.intent === 'RENTER' ? 'renter' : 'buyer'
    const beds = bedsText(m.bedsMin, m.bedsMax)
    cards.push({
      id: m.id,
      kind: 'party',
      role,
      category: role === 'renter' ? 'CRM_RENTER' : 'CRM_BUYER',
      title: `CRM ${role}${hood ? ` in ${hood}` : ''}${beds ? `, ${beds}` : ''}`,
      name: m.fullName,
      phone: null,
      neighborhood: hood,
      beds: m.bedsMin != null && m.bedsMin === m.bedsMax ? m.bedsMin : null,
      priceRange: m.budgetMin != null && m.budgetMax != null ? [m.budgetMin, m.budgetMax] : null,
      ...(overlap !== undefined ? { priceOverlapScore: overlap } : {}),
      isTestData: m.isTestData,
    })
  }

  if (range) cards.sort((a, b) => (b.priceOverlapScore ?? 0) - (a.priceOverlapScore ?? 0))

  const totalMatched = cards.length
  return {
    cards: cards.slice(0, limit),
    totalMatched,
    filtersApplied: input,
  }
}

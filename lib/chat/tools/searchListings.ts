// Brief 3.0, Step 1a — search_listings tool.
//
// Direct DB search over ExtractedOpportunity listing inventory, callable by
// Haiku 4.5 in the chat route's tool_use loop. Replaces the lossy
// parseQuery -> rigid-SQL retrieval path: the model reads the user's English,
// picks these filters itself, and iterates if needed.
//
// Borough is derived from the neighborhood (getBorough(fromRaw(...))) rather
// than trusted from the `borough` column — seed rows (and many real rows) carry
// `neighborhood` but a null `borough`, so a strict column filter would return
// zero for e.g. a Manhattan query. Deriving it is what makes the NYC
// "below 70th street -> Manhattan" convention actually resolve to results.
//
// Price: priceMin/priceMax feed priceOverlapScore (reused from
// lib/matching/priceOverlap.ts). Only rows scoring exactly 0 (out of range, past
// tolerance) are dropped — respecting Brief 2.5's price-gate tightening.
//
// Brief 43 PR 7 (Q11, Q12, Q13, Q40; N6, N12):
//   - "under $X" is a hard ceiling: the default tolerance is 0 (RYAN_MD §10
//     "under $X = hard ceiling"); a stretch only when Drift asks for one
//     (priceTolerance, for "close fits"). "around $X" (priceAround) is X ±15%
//     (RYAN_MD §10's ±10-15% flex), sorted closest to X first.
//   - Area, price, beds, units and address filters run in the database
//     (listingsWhere), so the newest-500 pool no longer hides an older listing.
//     Each database filter keeps a superset of what the exact checks below keep;
//     the exact checks still decide. Borough stays in code (it's derived from
//     the neighborhood).
//   - An area means that area (neighborhoodMatch.ts); an address means that
//     address (addressMatch.ts).
//   - Cards carry units, property type, square feet, availability date and the
//     source brokerage; unitsMin/unitsMax and propertyTypes filter on them.
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { Category, Prisma } from '@prisma/client'
import { fromRaw, getBorough } from '@/lib/domain/Neighborhood'
import { priceOverlapScore } from '@/lib/matching/priceOverlap'
import { listingPropertyClasses, type PropertyClass } from '@/lib/matching/propertyTypes'
import { isTestModeOnly } from '@/lib/config/testMode'
import { bedsMatches } from './searchParties'
import { hoodSqlTerms, hoodsMatch, wantedHoods } from './neighborhoodMatch'
import { addressMatch, addressSqlTerm, parseStreetAddress } from './addressMatch'

// Listing categories this tool exposes (sale + rental supply the chat surfaces).
const SALE_CATS = ['COMING_SOON_SALE', 'OFF_MARKET_SALE', 'ACTIVE_SALE_LISTING'] as const
const RENTAL_CATS = ['COMING_SOON_RENTAL', 'RENTAL_LISTING'] as const
const LISTING_CATS = [...SALE_CATS, ...RENTAL_CATS] as const

const BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'] as const

// Brief 43 PR 7 (Q12): building types, in matching's vocabulary
// (lib/matching/propertyTypes.ts), so "2-3 family" and "condo" mean the same here.
export const PROPERTY_TYPE_FILTERS = [
  'multifamily', 'condo', 'coop', 'townhouse', 'single_family', 'mixed_use', 'land', 'commercial',
] as const satisfies readonly PropertyClass[]

// RYAN_MD §10: "around $X" allows ±10-15% flex; priceAround uses the 15% edge.
const AROUND_BAND = 0.15

export const searchListingsInputSchema = z.object({
  borough: z.enum(BOROUGHS).optional(),
  neighborhoods: z.array(z.string()).optional(),
  nearby: z.boolean().optional(),
  address: z.string().max(200).optional(),
  beds: z.number().optional(),
  bedsMin: z.number().optional(),
  bedsMax: z.number().optional(),
  priceMin: z.number().optional(),
  priceMax: z.number().optional(),
  priceAround: z.number().optional(),
  unitsMin: z.number().optional(),
  unitsMax: z.number().optional(),
  propertyTypes: z.array(z.enum(PROPERTY_TYPE_FILTERS)).optional(),
  category: z.array(z.enum(LISTING_CATS)).optional(),
  intent: z.enum(['sale', 'rental']).optional(),
  priceTolerance: z.number().min(0).max(0.3).optional(),
  includeTestData: z.boolean().optional(),
  limit: z.number().int().positive().max(200).optional(),
})

export type SearchListingsInput = z.infer<typeof searchListingsInputSchema>

export interface ListingCard {
  id: string
  kind: 'listing'
  category: string
  title: string
  neighborhood: string | null
  beds: number | null
  price: number | null
  priceRange: [number, number] | null
  priceOverlapScore?: number
  address: string | null
  // Brief 43 PR 7 (Q12): null = not on file.
  units: number | null
  propertyType: string | null
  squareFeet: number | null
  availabilityDate: string | null
  sourceBrokerage: string | null
  isTestData: boolean
}

export interface SearchListingsResult {
  cards: ListingCard[]
  totalMatched: number
  filtersApplied: SearchListingsInput
}

// intent is convenience sugar: expand to the matching category group unless the
// caller already pinned an explicit category list.
function resolveCategories(input: SearchListingsInput): Category[] {
  if (input.category && input.category.length > 0) return input.category as Category[]
  if (input.intent === 'sale') return SALE_CATS as unknown as Category[]
  if (input.intent === 'rental') return RENTAL_CATS as unknown as Category[]
  return LISTING_CATS as unknown as Category[]
}

// Brief 43 PR 7: the asked budget. "around X" is X ±15% unless a min or max was
// also given (those win); a min above the max is read as the same range swapped.
// target is what results sort closest to: X for "around", else the middle of a
// two-sided range (Q40), else none (newest first).
export function askedBudget(input: Pick<SearchListingsInput, 'priceMin' | 'priceMax' | 'priceAround'>): { min: number | null; max: number | null; target: number | null } {
  const around = input.priceAround != null && input.priceAround > 0 ? input.priceAround : null
  let min = input.priceMin ?? (around != null ? Math.round(around * (1 - AROUND_BAND)) : null)
  let max = input.priceMax ?? (around != null ? Math.round(around * (1 + AROUND_BAND)) : null)
  if (min != null && max != null && min > max) [min, max] = [max, min]
  return { min, max, target: around ?? (min != null && max != null ? (min + max) / 2 : null) }
}

// A number range filter with only the given bounds.
function between(lo: number | null, hi: number | null): { gte?: number; lte?: number } {
  return { ...(lo != null ? { gte: lo } : {}), ...(hi != null ? { lte: hi } : {}) }
}

// Brief 43 PR 7 (N12): the SQL side of the price gate. A superset of what
// priceOverlapScore keeps: it can't compute a range listing's midpoint, so a
// listing stored as "from $X to $Y" passes when its ends straddle the band and
// the exact score below decides. Mirrors the effective price: price, else the
// range's midpoint, else whichever end is set.
function priceWhere(min: number | null, max: number | null, tolerance: number): Prisma.ExtractedOpportunityWhereInput | null {
  if (min == null && max == null) return null
  const stretch = (max ?? min ?? 0) * tolerance
  const lo = min != null ? min - stretch : null
  const hi = max != null ? max + stretch : null
  const ends: Prisma.ExtractedOpportunityWhereInput[] = []
  if (hi != null) ends.push({ OR: [{ minPrice: { lte: hi } }, { maxPrice: { lte: hi } }] })
  if (lo != null) ends.push({ OR: [{ minPrice: { gte: lo } }, { maxPrice: { gte: lo } }] })
  return {
    OR: [
      { price: between(lo, hi) },
      { price: null, minPrice: { not: null }, maxPrice: { not: null }, AND: ends },
      { price: null, minPrice: null, maxPrice: between(lo, hi) },
      { price: null, maxPrice: null, minPrice: between(lo, hi) },
    ],
  }
}

// Brief 43 PR 7 (N12): the SQL side of bedsMatches (Brief 30.2's range-aware
// rule: a fully unknown row stays; a row with only minBeds or only maxBeds is
// that exact count). minBeds/maxBeds are Int columns, so fractional bounds are
// rounded inward (an Int is >= 2.5 exactly when it's >= 3).
function bedsWhere(exact: number | null, wantMin: number | null, wantMax: number | null): Prisma.ExtractedOpportunityWhereInput | null {
  if (exact == null && wantMin == null && wantMax == null) return null
  const lo = exact ?? wantMin, hi = exact ?? wantMax
  const intLo = lo != null ? Math.ceil(lo) : null, intHi = hi != null ? Math.floor(hi) : null
  return {
    OR: [
      { beds: null, minBeds: null, maxBeds: null },
      { beds: between(lo, hi) },
      { beds: null, minBeds: intHi != null ? { lte: intHi } : { not: null }, maxBeds: intLo != null ? { gte: intLo } : { not: null } },
      { beds: null, minBeds: between(intLo, intHi), maxBeds: null },
      { beds: null, minBeds: null, maxBeds: between(intLo, intHi) },
    ],
  }
}

// Brief 43 PR 7: everything the database can filter. Exported for the tests.
export function listingsWhere(input: SearchListingsInput, organizationId: string): Prisma.ExtractedOpportunityWhereInput {
  const where: Prisma.ExtractedOpportunityWhereInput = {
    organizationId,
    category: { in: resolveCategories(input) },
    isDuplicate: false,
    processingStatus: 'active',
  }
  if (!(input.includeTestData ?? true)) where.isTestData = false  // seed-only test mode: default on
  // TEST_MODE_ONLY hard gate: force seed data, overriding whatever Haiku sent
  // for includeTestData. Transparent to the model — the tool schema is unchanged.
  if (isTestModeOnly()) where.isTestData = true

  const and: Prisma.ExtractedOpportunityWhereInput[] = []
  // Address: one distinctive street word, case-insensitive, parameterized by
  // Prisma (injection-safe); addressMatch below checks the number and street.
  if (input.address) and.push({ address: { contains: addressSqlTerm(input.address) ?? input.address, mode: 'insensitive' } })
  // Area: any spelling of the wanted areas. Listings rarely fill the
  // `neighborhoods` array (it's buyer criteria), so a row with one goes to the
  // exact check rather than being judged here.
  const hoods = wantedHoods(input.neighborhoods, input.nearby)
  if (hoods.length > 0) {
    and.push({
      OR: [
        ...hoodSqlTerms(hoods).map(t => ({ neighborhood: { contains: t, mode: 'insensitive' as const } })),
        { neighborhoods: { isEmpty: false } },
      ],
    })
  }
  const budget = askedBudget(input)
  const price = priceWhere(budget.min, budget.max, input.priceTolerance ?? 0)
  if (price) and.push(price)
  const beds = bedsWhere(input.beds ?? null, input.bedsMin ?? null, input.bedsMax ?? null)
  if (beds) and.push(beds)
  // Units: a null count may still be read from the type text below.
  if (input.unitsMin != null || input.unitsMax != null) {
    and.push({ OR: [{ units: null }, { units: between(input.unitsMin ?? null, input.unitsMax ?? null) }] })
  }
  if (and.length > 0) where.AND = and
  return where
}

// Brief 43 PR 7 (Q12): the unit count on file, else one stated in the type text
// ("Two Family", "3-family", "4 units").
const UNITS_IN_TYPE = /\b([1-9]\d?|one|two|three|four|five|six)[\s-]?(?:family|fam|units?)\b/
const WORD_COUNTS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }
function unitCount(units: number | null, propertyType: string | null): number | null {
  if (units != null) return units
  const m = (propertyType ?? '').toLowerCase().match(UNITS_IN_TYPE)
  return m ? WORD_COUNTS[m[1]] ?? Number(m[1]) : null
}

export async function searchListings(rawInput: SearchListingsInput): Promise<SearchListingsResult> {
  const input = searchListingsInputSchema.parse(rawInput)
  const organizationId = await getCurrentOrgId()

  const limit = input.limit ?? 50
  // Brief 43 PR 7 (N6): default 0, so "under $X" is a hard ceiling.
  const tolerance = input.priceTolerance ?? 0

  // ── SQL-level filters (see listingsWhere) ─────────────────────────────────
  // Beds stay range-aware (Brief 30.2): listings can store beds as a range
  // (minBeds/maxBeds with scalar beds null — new development / sponsor units,
  // partial extractions), and bedsWhere keeps those; bedsMatches below decides.
  const where = listingsWhere(input, organizationId)

  // A generous pool of rows that already pass the database filters; borough and
  // the exact checks run in JS below, then truncate to `limit`.
  const candidates = await prisma.extractedOpportunity.findMany({
    where,
    take: 500,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, category: true, extractedTitle: true, address: true,
      neighborhood: true, neighborhoods: true, borough: true,
      beds: true, minBeds: true, maxBeds: true,
      price: true, minPrice: true, maxPrice: true, isTestData: true,
      units: true, propertyType: true, squareFeet: true, availabilityDate: true, sourceBrokerage: true,
    },
  })

  const wantBorough = input.borough ?? null
  const wantHoods = wantedHoods(input.neighborhoods, input.nearby)
  const budget = askedBudget(input)
  const hasPriceFilter = budget.min != null || budget.max != null
  const wantAddress = input.address ? parseStreetAddress(input.address) : null
  const wantUnits = input.unitsMin != null || input.unitsMax != null
  const wantTypes = input.propertyTypes ?? []

  const kept: Array<{ card: ListingCard; price: number | null; addressRank: number }> = []
  for (const o of candidates) {
    // Borough gate — derive from neighborhood when the column is null.
    if (wantBorough) {
      const rowBorough =
        o.borough ?? (o.neighborhood ? getBorough(fromRaw(o.neighborhood) ?? '') : null)
      if (!rowBorough || rowBorough.toLowerCase() !== wantBorough.toLowerCase()) continue
    }

    // Neighborhood gate — the singular field + the array, exact canonical names
    // (Brief 43 PR 7, Q13: Williamsburg is not East Williamsburg).
    if (!hoodsMatch(wantHoods, [o.neighborhood, ...(o.neighborhoods ?? [])])) continue

    // Address gate — exact house number, then the street (Brief 43 PR 7, Q11).
    let addressRank = 0
    if (wantAddress) {
      const m = addressMatch(wantAddress, parseStreetAddress(o.address))
      if (!m) continue
      addressRank = m === 'exact' ? 0 : 1
    }

    // Beds gate — range-aware (Brief 30.2); a listing storing beds as minBeds/maxBeds
    // with scalar null is matched via its effective range, not dropped.
    if (!bedsMatches(input.beds ?? null, input.bedsMin ?? null, input.bedsMax ?? null, o.beds, o.minBeds, o.maxBeds)) continue

    // Units and type gates (Brief 43 PR 7, Q12). Asked for, they need the fact on
    // file: a listing with no unit count or type is left out, never guessed in.
    if (wantUnits) {
      const u = unitCount(o.units, o.propertyType)
      if (u == null || (input.unitsMin != null && u < input.unitsMin) || (input.unitsMax != null && u > input.unitsMax)) continue
    }
    if (wantTypes.length > 0) {
      const classes = listingPropertyClasses({ propertyType: o.propertyType, propertyTypeDetail: null, unitCount: o.units })
      if (!wantTypes.some(t => classes.has(t))) continue
    }

    // Price gate — fractional overlap; drop only true 0-overlap when a budget was given.
    // Effective listing price: prefer scalar, else the midpoint of the listing's own
    // range (new dev / sponsor units store "from $X to $Y" as minPrice/maxPrice).
    const effectivePrice = o.price ??
      (o.minPrice != null && o.maxPrice != null ? (o.minPrice + o.maxPrice) / 2 :
       o.maxPrice ?? o.minPrice ?? null)
    let overlap: number | undefined
    if (hasPriceFilter) {
      overlap = priceOverlapScore(effectivePrice, budget.min, budget.max, tolerance)
      if (overlap === 0) continue
    }

    kept.push({
      price: effectivePrice,
      addressRank,
      card: {
        id: o.id,
        kind: 'listing',
        category: o.category,
        title: o.extractedTitle,
        neighborhood: o.neighborhood,
        beds: o.beds,
        price: o.price,
        priceRange: o.minPrice != null && o.maxPrice != null ? [o.minPrice, o.maxPrice] : null,
        ...(overlap !== undefined ? { priceOverlapScore: overlap } : {}),
        address: o.address,
        units: o.units,
        propertyType: o.propertyType,
        squareFeet: o.squareFeet,
        availabilityDate: o.availabilityDate,
        sourceBrokerage: o.sourceBrokerage,
        isTestData: o.isTestData,
      },
    })
  }

  // Rank: the exact address first; then best price fit when a budget was given;
  // then closest to the asked price ("around 3M", or the middle of a range; Brief
  // 43 PR 7, Q40); else freshest (candidates arrive createdAt-desc and the sort
  // is stable, so ties stay newest first).
  const distance = (p: number | null) => (budget.target == null ? 0 : p == null ? Number.MAX_VALUE : Math.abs(p - budget.target))
  kept.sort((a, b) =>
    a.addressRank - b.addressRank ||
    (b.card.priceOverlapScore ?? 0) - (a.card.priceOverlapScore ?? 0) ||
    distance(a.price) - distance(b.price))
  const cards = kept.map(k => k.card)

  const totalMatched = cards.length
  return {
    cards: cards.slice(0, limit),
    totalMatched,
    filtersApplied: input,
  }
}

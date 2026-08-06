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
// Price is NOT a hard SQL filter: priceMin/priceMax feed priceOverlapScore
// (reused from lib/matching/priceOverlap.ts) so fractional near-misses survive.
// Only rows scoring exactly 0 (fully out of range, past tolerance) are dropped —
// respecting Brief 2.5's price-gate tightening.
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { Category, Prisma } from '@prisma/client'
import { fromRaw, getBorough } from '@/lib/domain/Neighborhood'
import { priceOverlapScore } from '@/lib/matching/priceOverlap'

// Listing categories this tool exposes (sale + rental supply the chat surfaces).
const SALE_CATS = ['COMING_SOON_SALE', 'OFF_MARKET_SALE', 'ACTIVE_SALE_LISTING'] as const
const RENTAL_CATS = ['COMING_SOON_RENTAL', 'RENTAL_LISTING'] as const
const LISTING_CATS = [...SALE_CATS, ...RENTAL_CATS] as const

const BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'] as const

export const searchListingsInputSchema = z.object({
  borough: z.enum(BOROUGHS).optional(),
  neighborhoods: z.array(z.string()).optional(),
  address: z.string().max(200).optional(),
  beds: z.number().optional(),
  bedsMin: z.number().optional(),
  bedsMax: z.number().optional(),
  priceMin: z.number().optional(),
  priceMax: z.number().optional(),
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

// Canonicalize a neighborhood string for comparison; falls back to the trimmed
// lowercase raw when it isn't in the domain map (keeps unknown hoods matchable).
function canon(n: string | null | undefined): string | null {
  if (!n) return null
  return fromRaw(n) ?? n.trim().toLowerCase()
}

export async function searchListings(rawInput: SearchListingsInput): Promise<SearchListingsResult> {
  const input = searchListingsInputSchema.parse(rawInput)
  const organizationId = await getCurrentOrgId()

  const categories = resolveCategories(input)
  const limit = input.limit ?? 50
  const tolerance = input.priceTolerance ?? 0.05
  const includeTestData = input.includeTestData ?? true  // seed-only test mode: default on

  // ── SQL-level filters (cheap, exact) ──────────────────────────────────────
  // Price is intentionally excluded here — it's applied via priceOverlapScore
  // below so near-misses survive. Beds exact/min/max handled in SQL.
  const where: Prisma.ExtractedOpportunityWhereInput = {
    organizationId,
    category: { in: categories },
    isDuplicate: false,
    processingStatus: 'active',
  }
  if (!includeTestData) where.isTestData = false
  // Address substring — case-insensitive, parameterized by Prisma (injection-safe).
  // Lets Haiku answer direct-address queries ("anything at 88 Greenwich Ave?")
  // instead of falling back to a broad search + mental filter.
  if (input.address) where.address = { contains: input.address, mode: 'insensitive' }
  if (input.beds != null) where.beds = input.beds
  else if (input.bedsMin != null || input.bedsMax != null) {
    where.beds = {
      ...(input.bedsMin != null ? { gte: input.bedsMin } : {}),
      ...(input.bedsMax != null ? { lte: input.bedsMax } : {}),
    }
  }

  // Fetch a generous candidate pool; borough/neighborhood/price are refined in
  // JS below, so we over-fetch relative to `limit` and truncate after.
  const candidates = await prisma.extractedOpportunity.findMany({
    where,
    take: 500,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, category: true, extractedTitle: true, address: true,
      neighborhood: true, neighborhoods: true, borough: true,
      beds: true, price: true, minPrice: true, maxPrice: true, isTestData: true,
    },
  })

  const wantBorough = input.borough ?? null
  const wantHoods = (input.neighborhoods ?? []).map(canon).filter((c): c is string => c != null)
  const hasPriceFilter = input.priceMin != null || input.priceMax != null

  const cards: ListingCard[] = []
  for (const o of candidates) {
    // Borough gate — derive from neighborhood when the column is null.
    if (wantBorough) {
      const rowBorough =
        o.borough ?? (o.neighborhood ? getBorough(fromRaw(o.neighborhood) ?? '') : null)
      if (!rowBorough || rowBorough.toLowerCase() !== wantBorough.toLowerCase()) continue
    }

    // Neighborhood gate — match against the singular field + the array, canonicalized.
    if (wantHoods.length > 0) {
      const rowHoods = new Set<string>()
      const single = canon(o.neighborhood)
      if (single) rowHoods.add(single)
      for (const n of o.neighborhoods ?? []) {
        const c = canon(n)
        if (c) rowHoods.add(c)
      }
      const hit = wantHoods.some(w =>
        rowHoods.has(w) || [...rowHoods].some(r => r.includes(w) || w.includes(r)),
      )
      if (!hit) continue
    }

    // Price gate — fractional overlap; drop only true 0-overlap when a budget was given.
    let overlap: number | undefined
    if (hasPriceFilter) {
      overlap = priceOverlapScore(o.price, input.priceMin ?? null, input.priceMax ?? null, tolerance)
      if (overlap === 0) continue
    }

    cards.push({
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
      isTestData: o.isTestData,
    })
  }

  // Rank: best price fit first when a budget was given, else freshest (candidates
  // already arrive createdAt-desc, so a stable pass preserves that).
  if (hasPriceFilter) {
    cards.sort((a, b) => (b.priceOverlapScore ?? 0) - (a.priceOverlapScore ?? 0))
  }

  const totalMatched = cards.length
  return {
    cards: cards.slice(0, limit),
    totalMatched,
    filtersApplied: input,
  }
}

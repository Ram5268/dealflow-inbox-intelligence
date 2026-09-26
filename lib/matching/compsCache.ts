// Brief 32 — pre-computed context the scorer needs but can't derive per-pair:
//   • carrying-cost medians per (neighborhood, $500k band, propertyType) bucket
//   • substitution scarcity counts per buyer
// Both are computed ONCE before a scoring run and passed via ScoringContext.
//
// The median math and the scarcity count are pure functions (testable without a
// DB); precomputeCompsMedians wraps the median math with a Prisma query. Prisma
// is imported type-only so this module stays ts-node friendly.
import type { PrismaClient } from '@prisma/client'
import type { ListingData, BuyerData } from './scorerTypes'
import { carryingBucketKey } from './compsKey'
import { isNeighborhoodEligible, isBedsEligible, isPriceEligible } from './eligibility'

export interface CompsMedianContext {
  medians: Map<string, number> // key: `${nbhd}|${band}|${propType}` → median monthly carrying $
  counts: Map<string, number> // comparables per bucket (for confidence)
}

export interface CarryingRow {
  neighborhood: string | null
  price: number | null
  propertyType: string | null
  monthly: number
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

// Pure: bucket carrying rows, keep buckets with >= minComps, compute medians.
export function medianByBucket(rows: CarryingRow[], minComps = 5): CompsMedianContext {
  const buckets = new Map<string, number[]>()
  for (const r of rows) {
    const key = carryingBucketKey(r.neighborhood, r.price, r.propertyType)
    const arr = buckets.get(key) ?? []
    arr.push(r.monthly)
    buckets.set(key, arr)
  }
  const medians = new Map<string, number>()
  const counts = new Map<string, number>()
  for (const [key, vals] of buckets) {
    counts.set(key, vals.length)
    if (vals.length >= minComps) medians.set(key, median(vals))
  }
  return { medians, counts }
}

// Fetch listing-side carrying data and compute medians. Carrying costs live only
// on ExtractedOpportunity listings (MojoContact sellers carry no monthly fields),
// so we only query there.
export async function precomputeCompsMedians(
  prisma: Pick<PrismaClient, 'extractedOpportunity'>,
  orgId: string,
): Promise<CompsMedianContext> {
  const opps = await prisma.extractedOpportunity.findMany({
    where: {
      organizationId: orgId,
      OR: [
        { monthlyMaintenance: { not: null } },
        { monthlyCommonCharges: { not: null } },
        { monthlyTaxes: { not: null } },
      ],
    },
    select: {
      neighborhood: true, price: true, propertyType: true,
      monthlyMaintenance: true, monthlyCommonCharges: true, monthlyTaxes: true,
    },
  })
  const rows: CarryingRow[] = opps.map(o => ({
    neighborhood: o.neighborhood,
    price: o.price,
    propertyType: o.propertyType,
    monthly: (o.monthlyMaintenance ?? 0) + (o.monthlyCommonCharges ?? 0) + (o.monthlyTaxes ?? 0),
  }))
  return medianByBucket(rows)
}

// Pure: for each buyer, count listings that pass their core eligibility gates
// (neighborhood / beds / price). Fewer substitutes → higher scarcity value.
export function precomputeSubstitutionCounts(
  buyers: BuyerData[],
  listings: ListingData[],
): Map<string, number> {
  const out = new Map<string, number>()
  for (const b of buyers) {
    let count = 0
    for (const l of listings) {
      if (
        isNeighborhoodEligible(l.neighborhood, b.neighborhoods, l.borough) &&
        isBedsEligible(l.beds, b.bedsMin, b.bedsMax) &&
        isPriceEligible(l.price, b.priceMin, b.priceMax)
      ) {
        count++
      }
    }
    out.set(b.id, count)
  }
  return out
}

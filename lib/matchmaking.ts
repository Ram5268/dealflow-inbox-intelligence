import { prisma } from './prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { Category } from '@prisma/client'
import { fromRaw, getAdjacent, getBorough } from './domain/Neighborhood'
import { SUPPLY_SALE, SUPPLY_RENTAL } from './domain/Categories'
import { priceOverlapScore } from './matching/priceOverlap'
import { bedsScore } from './matching/bedsScore'

// Borough detection — delegates to lib/domain. Returns lowercase to preserve
// the legacy contract used by neighborhoodScore. Falls back to 'manhattan'
// when the neighborhood doesn't resolve, mirroring the prior heuristic's
// last-resort default.
function detectBorough(neighborhood: string): string {
  const canonical = fromRaw(neighborhood)
  if (!canonical) return 'manhattan'
  const borough = getBorough(canonical)
  return borough ? borough.toLowerCase() : 'manhattan'
}

function neighborhoodScore(n1: string | null | undefined, n2: string | null | undefined): number {
  if (!n1 || !n2) return 5 // slight credit when unknown
  const a = n1.toLowerCase().trim()
  const b = n2.toLowerCase().trim()
  if (a === b || a.includes(b) || b.includes(a)) return 40
  const adjacents = getAdjacent(a)
  if (adjacents.some(adj => b.includes(adj) || adj.includes(b))) return 25
  if (detectBorough(a) === detectBorough(b)) return 10
  return 0
}

// Brief 2.5, Step 4 — fractional price component. The old priceScore returned a
// binary/stepped 0/10/20/30. Now the [0..1] priceOverlapScore is scaled to the
// same 0..30 band, and the pair is *price-gated* when both sides carry price
// data but the overlap is 0 (listing >5% outside the party's range) — such a
// pair is disqualified regardless of neighborhood/beds. When price data is
// missing on either side we can't judge price: no gate, small neutral credit
// (preserves prior behavior for price-less listings/demand).
const PRICE_WEIGHT = 30

function pricePart(
  listingPrice: number | null | undefined,
  isoMinPrice: number | null | undefined,
  isoMaxPrice: number | null | undefined
): { points: number; overlap: number; gated: boolean } {
  const hasPrice = listingPrice != null && (isoMinPrice != null || isoMaxPrice != null)
  if (!hasPrice) return { points: 5, overlap: NaN, gated: false }
  const overlap = priceOverlapScore(listingPrice, isoMinPrice ?? null, isoMaxPrice ?? null)
  return { points: overlap * PRICE_WEIGHT, overlap, gated: overlap === 0 }
}

export interface MatchScore {
  score: number        // neighborhood(0..40) + price(0..30) + beds(0..20)
  priceOverlap: number // [0..1] fractional overlap, or NaN when price data is missing
  priceGated: boolean  // true => disqualified on price despite other criteria
}

export function scoreMatch(
  listing: { neighborhood?: string | null; price?: number | null; beds?: number | null },
  demand: { neighborhood?: string | null; minPrice?: number | null; maxPrice?: number | null; beds?: number | null }
): MatchScore {
  const price = pricePart(listing.price, demand.minPrice, demand.maxPrice)
  const score =
    neighborhoodScore(listing.neighborhood, demand.neighborhood) +
    price.points +
    bedsScore(listing.beds, demand.beds)
  return { score, priceOverlap: price.overlap, priceGated: price.gated }
}

// A pair qualifies as a match when it is not price-gated AND clears the score
// threshold. Fractional near-misses (overlap 0.01..0.99) are retained — those
// are exactly the pairs Brief 2.5 wants surfaced.
export function qualifiesAsMatch(m: MatchScore): boolean {
  return !m.priceGated && m.score >= 50
}

// Note: matchmaking's prior SALE_CATEGORIES omitted PRICE_DROP and
// COMING_SOON_DEVELOPMENT vs lib/domain's SUPPLY_SALE. SUPPLY_SALE is the
// canonical set (8 categories) — additive change here is intentional Phase B
// consolidation. PRICE_DROP and COMING_SOON_DEVELOPMENT listings will now
// be considered for buyer-ISO matching, which is the correct behavior.
const SALE_CATEGORIES: Category[]   = [...SUPPLY_SALE]
const RENTAL_CATEGORIES: Category[] = [...SUPPLY_RENTAL]

export interface MatchResult {
  highConfidence: number
  total: number
  topMatches: Array<{ title: string; reason: string; score: number }>
}

export async function runMatchmaking(newOppIds: string[]): Promise<MatchResult> {
  if (newOppIds.length === 0) return { highConfidence: 0, total: 0, topMatches: [] }

  const organizationId = await getCurrentOrgId()

  const newOpps = await prisma.extractedOpportunity.findMany({
    where: { id: { in: newOppIds }, isDuplicate: false },
    select: { id: true, category: true, neighborhood: true, borough: true,
              price: true, minPrice: true, maxPrice: true, beds: true,
              propertyType: true, extractedTitle: true },
  })

  const newSaleListings = newOpps.filter(o => SALE_CATEGORIES.includes(o.category))
  const newRentalListings = newOpps.filter(o => RENTAL_CATEGORIES.includes(o.category))
  const newBuyerISOs = newOpps.filter(o => o.category === Category.BUYER_ISO)
  const newRenterInquiries = newOpps.filter(o => o.category === Category.RENTER_INQUIRY)

  const created: Array<{ score: number; reason: string; title: string }> = []

  // New sale listings ↔ all active BUYER_ISOs
  if (newSaleListings.length > 0) {
    const allISOs = await prisma.extractedOpportunity.findMany({
      where: { category: Category.BUYER_ISO, isDuplicate: false },
      select: { id: true, neighborhood: true, minPrice: true, maxPrice: true, beds: true, extractedTitle: true },
    })
    for (const listing of newSaleListings) {
      for (const iso of allISOs) {
        const m = scoreMatch(listing, iso)
        const score = Math.round(m.score)
        if (qualifiesAsMatch(m)) {
          const reason = `${listing.extractedTitle} may match ISO: ${iso.extractedTitle} (score ${score})`
          await prisma.match.create({ data: { organizationId, opportunityId: listing.id, counterpartId: iso.id, counterpartType: 'opportunity', score, reason } }).catch(() => {})
          created.push({ score, reason, title: listing.extractedTitle })
        }
      }
    }
  }

  // New rental listings ↔ all active RENTER_INQUIRYs
  if (newRentalListings.length > 0) {
    const allInquiries = await prisma.extractedOpportunity.findMany({
      where: { category: Category.RENTER_INQUIRY, isDuplicate: false },
      select: { id: true, neighborhood: true, minPrice: true, maxPrice: true, beds: true, extractedTitle: true },
    })
    for (const listing of newRentalListings) {
      for (const inq of allInquiries) {
        const m = scoreMatch(listing, inq)
        const score = Math.round(m.score)
        if (qualifiesAsMatch(m)) {
          const reason = `${listing.extractedTitle} may match renter: ${inq.extractedTitle} (score ${score})`
          await prisma.match.create({ data: { organizationId, opportunityId: listing.id, counterpartId: inq.id, counterpartType: 'opportunity', score, reason } }).catch(() => {})
          created.push({ score, reason, title: listing.extractedTitle })
        }
      }
    }
  }

  // New BUYER_ISOs ↔ all sale listings
  if (newBuyerISOs.length > 0) {
    const allListings = await prisma.extractedOpportunity.findMany({
      where: { category: { in: SALE_CATEGORIES }, isDuplicate: false },
      select: { id: true, neighborhood: true, price: true, beds: true, extractedTitle: true },
    })
    for (const iso of newBuyerISOs) {
      for (const listing of allListings) {
        const m = scoreMatch(listing, { neighborhood: iso.neighborhood, minPrice: iso.minPrice, maxPrice: iso.maxPrice, beds: iso.beds })
        const score = Math.round(m.score)
        if (qualifiesAsMatch(m)) {
          const reason = `ISO: ${iso.extractedTitle} may match ${listing.extractedTitle} (score ${score})`
          await prisma.match.create({ data: { organizationId, opportunityId: iso.id, counterpartId: listing.id, counterpartType: 'opportunity', score, reason } }).catch(() => {})
          created.push({ score, reason, title: iso.extractedTitle })
        }
      }
      // Also match new ISO against Mojo seller leads
      const mojoLeads = await prisma.mojoContact.findMany({
        where: iso.neighborhood ? {
          OR: [
            { neighborhood: { contains: iso.neighborhood, mode: 'insensitive' } },
            { city: { contains: iso.neighborhood, mode: 'insensitive' } },
          ]
        } : {},
        take: 30,
        select: { id: true, fullName: true, neighborhood: true, address: true },
      })
      for (const mojo of mojoLeads) {
        const score = neighborhoodScore(iso.neighborhood, mojo.neighborhood ?? mojo.address)
        if (score >= 25) {
          const reason = `Mojo lead ${mojo.fullName} at ${mojo.address} may match ISO: ${iso.extractedTitle}`
          await prisma.match.create({ data: { organizationId, opportunityId: iso.id, counterpartId: mojo.id, counterpartType: 'mojo', score, reason } }).catch(() => {})
          created.push({ score, reason, title: iso.extractedTitle })
        }
      }
    }
  }

  // New RENTER_INQUIRYs ↔ all rental listings
  if (newRenterInquiries.length > 0) {
    const allRentals = await prisma.extractedOpportunity.findMany({
      where: { category: { in: RENTAL_CATEGORIES }, isDuplicate: false },
      select: { id: true, neighborhood: true, price: true, beds: true, extractedTitle: true },
    })
    for (const inq of newRenterInquiries) {
      for (const rental of allRentals) {
        const m = scoreMatch(rental, { neighborhood: inq.neighborhood, minPrice: inq.minPrice, maxPrice: inq.maxPrice, beds: inq.beds })
        const score = Math.round(m.score)
        if (qualifiesAsMatch(m)) {
          const reason = `Renter inquiry may match ${rental.extractedTitle} (score ${score})`
          await prisma.match.create({ data: { organizationId, opportunityId: inq.id, counterpartId: rental.id, counterpartType: 'opportunity', score, reason } }).catch(() => {})
          created.push({ score, reason, title: inq.extractedTitle })
        }
      }
    }
  }

  const highConfidence = created.filter(m => m.score >= 70).length
  const topMatches = created
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(m => ({ title: m.title, reason: m.reason, score: m.score }))

  return { highConfidence, total: created.length, topMatches }
}

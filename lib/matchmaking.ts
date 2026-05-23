import { prisma } from './prisma'
import { Category } from '@prisma/client'

// Neighborhoods that are considered adjacent for matching purposes
const ADJACENT: Record<string, string[]> = {
  tribeca: ['soho', 'financial district', 'two bridges', 'battery park city', 'little italy'],
  soho: ['tribeca', 'noho', 'nolita', 'little italy', 'west village'],
  noho: ['soho', 'nolita', 'east village', 'greenwich village'],
  nolita: ['soho', 'noho', 'little italy', 'lower east side'],
  'lower east side': ['east village', 'chinatown', 'two bridges', 'nolita'],
  'east village': ['lower east side', 'greenwich village', 'noho', 'kips bay'],
  chelsea: ['west village', "hell's kitchen", 'flatiron', 'hudson yards'],
  'west village': ['chelsea', 'greenwich village', 'soho'],
  flatiron: ['chelsea', 'gramercy', 'union square'],
  gramercy: ['flatiron', 'kips bay', 'murray hill', 'union square'],
  'murray hill': ['kips bay', 'midtown east', 'gramercy'],
  'kips bay': ['gramercy', 'murray hill', 'east village'],
  'hell\'s kitchen': ['chelsea', 'midtown west', 'hudson yards'],
  midtown: ['murray hill', 'kips bay', "hell's kitchen", 'chelsea', 'gramercy', 'midtown east', 'midtown west'],
  'midtown east': ['midtown', 'murray hill', 'upper east side'],
  'upper east side': ['yorkville', 'carnegie hill', 'lenox hill', 'east harlem'],
  'upper west side': ['morningside heights', 'manhattan valley', 'lincoln square'],
  yorkville: ['upper east side', 'carnegie hill', 'east harlem'],
  harlem: ['east harlem', 'morningside heights', 'washington heights'],
  'east harlem': ['harlem', 'yorkville', 'upper east side'],
  williamsburg: ['greenpoint', 'bushwick', 'bed-stuy'],
  greenpoint: ['williamsburg', 'long island city'],
  bushwick: ['williamsburg', 'bed-stuy', 'ridgewood'],
  'bed-stuy': ['bushwick', 'crown heights', 'fort greene', 'clinton hill'],
  'crown heights': ['bed-stuy', 'prospect heights', 'flatbush'],
  'prospect heights': ['crown heights', 'park slope', 'fort greene'],
  'park slope': ['prospect heights', 'carroll gardens', 'cobble hill', 'gowanus'],
  'carroll gardens': ['park slope', 'cobble hill', 'red hook', 'boerum hill'],
  'cobble hill': ['carroll gardens', 'park slope', 'boerum hill', 'brooklyn heights'],
  'fort greene': ['boerum hill', 'clinton hill', 'bed-stuy', 'downtown brooklyn'],
  'brooklyn heights': ['cobble hill', 'downtown brooklyn', 'dumbo'],
  dumbo: ['brooklyn heights', 'vinegar hill', 'downtown brooklyn'],
  'long island city': ['astoria', 'sunnyside', 'hunters point', 'greenpoint'],
  lic: ['astoria', 'sunnyside', 'hunters point'],
  astoria: ['long island city', 'lic', 'sunnyside', 'jackson heights'],
  sunnyside: ['astoria', 'long island city', 'woodside', 'jackson heights'],
  'jackson heights': ['elmhurst', 'woodside', 'corona', 'sunnyside'],
  'forest hills': ['rego park', 'kew gardens', 'jamaica estates'],
  'rego park': ['forest hills', 'elmhurst', 'corona', 'kew gardens'],
}

// Borough detection from neighborhood name
function detectBorough(neighborhood: string): string {
  const n = neighborhood.toLowerCase()
  const bkNeighborhoods = ['williamsburg', 'greenpoint', 'bushwick', 'bed-stuy', 'bedford', 'crown heights',
    'prospect', 'park slope', 'carroll gardens', 'cobble hill', 'boerum hill', 'fort greene', 'clinton hill',
    'brooklyn heights', 'dumbo', 'vinegar hill', 'red hook', 'gowanus', 'flatbush', 'ditmas', 'brownsville',
    'east new york', 'bay ridge', 'sunset park', 'borough park', 'bensonhurst', 'coney island', 'sheepshead']
  const queensNeighborhoods = ['astoria', 'long island city', 'lic', 'sunnyside', 'jackson heights',
    'elmhurst', 'woodside', 'corona', 'flushing', 'bayside', 'forest hills', 'rego park', 'kew gardens',
    'jamaica', 'richmond hill', 'ozone park', 'howard beach', 'little neck', 'douglaston', 'maspeth',
    'middle village', 'glendale', 'ridgewood', 'hunters point']
  if (bkNeighborhoods.some(b => n.includes(b))) return 'brooklyn'
  if (queensNeighborhoods.some(q => n.includes(q))) return 'queens'
  if (n.includes('bronx') || n.includes('riverdale') || n.includes('kingsbridge')) return 'bronx'
  return 'manhattan'
}

function neighborhoodScore(n1: string | null | undefined, n2: string | null | undefined): number {
  if (!n1 || !n2) return 5 // slight credit when unknown
  const a = n1.toLowerCase().trim()
  const b = n2.toLowerCase().trim()
  if (a === b || a.includes(b) || b.includes(a)) return 40
  const adjacents = ADJACENT[a] ?? []
  if (adjacents.some(adj => b.includes(adj) || adj.includes(b))) return 25
  if (detectBorough(a) === detectBorough(b)) return 10
  return 0
}

function priceScore(
  listingPrice: number | null | undefined,
  isoMinPrice: number | null | undefined,
  isoMaxPrice: number | null | undefined
): number {
  if (!listingPrice) return 5
  if (!isoMinPrice && !isoMaxPrice) return 5
  const min = isoMinPrice ?? 0
  const max = isoMaxPrice ?? Infinity
  if (listingPrice >= min && listingPrice <= max) return 30
  const closest = listingPrice < min ? min : max
  const pct = Math.abs(listingPrice - closest) / closest
  if (pct <= 0.15) return 20
  if (pct <= 0.25) return 10
  return 0
}

function bedsScore(listingBeds: number | null | undefined, isoBeds: number | null | undefined): number {
  if (!listingBeds || !isoBeds) return 5
  if (listingBeds === isoBeds) return 20
  if (Math.abs(listingBeds - isoBeds) === 1) return 10
  return 0
}

export function scoreMatch(
  listing: { neighborhood?: string | null; price?: number | null; beds?: number | null },
  demand: { neighborhood?: string | null; minPrice?: number | null; maxPrice?: number | null; beds?: number | null }
): number {
  return (
    neighborhoodScore(listing.neighborhood, demand.neighborhood) +
    priceScore(listing.price, demand.minPrice, demand.maxPrice) +
    bedsScore(listing.beds, demand.beds)
  )
}

const SALE_CATEGORIES: Category[] = [
  Category.ACTIVE_SALE_LISTING,
  Category.COMING_SOON_SALE,
  Category.OFF_MARKET_SALE,
  Category.BACK_ON_MARKET,
  Category.DEVELOPMENT_INVENTORY,
  Category.SPONSOR_UNIT,
]

const RENTAL_CATEGORIES: Category[] = [
  Category.RENTAL_LISTING,
  Category.COMING_SOON_RENTAL,
]

export interface MatchResult {
  highConfidence: number
  total: number
  topMatches: Array<{ title: string; reason: string; score: number }>
}

export async function runMatchmaking(newOppIds: string[]): Promise<MatchResult> {
  if (newOppIds.length === 0) return { highConfidence: 0, total: 0, topMatches: [] }

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
        const score = scoreMatch(listing, iso)
        if (score >= 50) {
          const reason = `${listing.extractedTitle} may match ISO: ${iso.extractedTitle} (score ${score})`
          await prisma.match.create({ data: { opportunityId: listing.id, counterpartId: iso.id, counterpartType: 'opportunity', score, reason } }).catch(() => {})
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
        const score = scoreMatch(listing, inq)
        if (score >= 50) {
          const reason = `${listing.extractedTitle} may match renter: ${inq.extractedTitle} (score ${score})`
          await prisma.match.create({ data: { opportunityId: listing.id, counterpartId: inq.id, counterpartType: 'opportunity', score, reason } }).catch(() => {})
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
        const score = scoreMatch(listing, { neighborhood: iso.neighborhood, minPrice: iso.minPrice, maxPrice: iso.maxPrice, beds: iso.beds })
        if (score >= 50) {
          const reason = `ISO: ${iso.extractedTitle} may match ${listing.extractedTitle} (score ${score})`
          await prisma.match.create({ data: { opportunityId: iso.id, counterpartId: listing.id, counterpartType: 'opportunity', score, reason } }).catch(() => {})
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
          await prisma.match.create({ data: { opportunityId: iso.id, counterpartId: mojo.id, counterpartType: 'mojo', score, reason } }).catch(() => {})
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
        const score = scoreMatch(rental, { neighborhood: inq.neighborhood, minPrice: inq.minPrice, maxPrice: inq.maxPrice, beds: inq.beds })
        if (score >= 50) {
          const reason = `Renter inquiry may match ${rental.extractedTitle} (score ${score})`
          await prisma.match.create({ data: { opportunityId: inq.id, counterpartId: rental.id, counterpartType: 'opportunity', score, reason } }).catch(() => {})
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

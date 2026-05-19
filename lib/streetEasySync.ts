import { prisma } from './prisma'
import { normalizeAddress } from './properties/normalizeAddress'

const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY  ?? ''
const RAPIDAPI_HOST = process.env.RAPIDAPI_SE_HOST ?? 'streeteasy-api.p.rapidapi.com'
const BASE_URL      = `https://${RAPIDAPI_HOST}`

// Supply-side categories that have real listings to check
const CHECKABLE_CATEGORIES = new Set([
  'ACTIVE_SALE_LISTING', 'RENTAL_LISTING', 'COMING_SOON_SALE', 'COMING_SOON_RENTAL',
  'OFF_MARKET_SALE', 'BACK_ON_MARKET', 'PRICE_DROP', 'OPEN_HOUSE',
  'DEVELOPMENT_INVENTORY', 'COMING_SOON_DEVELOPMENT', 'SPONSOR_UNIT',
])

// NYC neighborhood → StreetEasy area slug mapping
const NEIGHBORHOOD_TO_SE_AREA: Record<string, string> = {
  // Manhattan Downtown (below 14th St)
  'Financial District': 'all-downtown', 'FiDi': 'all-downtown',
  'Tribeca': 'all-downtown', 'SoHo': 'all-downtown', 'NoHo': 'all-downtown',
  'Nolita': 'all-downtown', 'Little Italy': 'all-downtown', 'Chinatown': 'all-downtown',
  'Lower East Side': 'all-downtown', 'LES': 'all-downtown',
  'Two Bridges': 'all-downtown', 'Battery Park City': 'all-downtown',
  'Greenwich Village': 'all-downtown', 'West Village': 'all-downtown',
  'East Village': 'all-downtown', 'Hudson Square': 'all-downtown',
  // Manhattan Midtown (14th–59th St)
  'Chelsea': 'all-midtown', 'West Chelsea': 'all-midtown',
  'Flatiron': 'all-midtown', 'NoMad': 'all-midtown',
  "Hell's Kitchen": 'all-midtown', 'Hells Kitchen': 'all-midtown', 'Clinton': 'all-midtown',
  'Gramercy': 'all-midtown', 'Gramercy Park': 'all-midtown',
  'Murray Hill': 'all-midtown', 'Kips Bay': 'all-midtown',
  'Midtown': 'all-midtown', 'Midtown West': 'all-midtown', 'Midtown East': 'all-midtown',
  'Midtown South': 'all-midtown', 'Hudson Yards': 'all-midtown',
  'Turtle Bay': 'all-midtown', 'Sutton Place': 'all-midtown',
  'Stuyvesant Town': 'all-midtown', 'Peter Cooper Village': 'all-midtown',
  // Manhattan Upper West Side + north (west of Central Park)
  'Upper West Side': 'all-upper-west-side', 'Lincoln Square': 'all-upper-west-side',
  'Manhattan Valley': 'all-upper-west-side', 'Riverside': 'all-upper-west-side',
  'Morningside Heights': 'all-upper-west-side', 'Hamilton Heights': 'all-upper-west-side',
  'Washington Heights': 'washington-heights', 'Inwood': 'inwood',
  'Manhattanville': 'all-upper-west-side',
  // Manhattan Upper East Side + north (east of Central Park)
  'Upper East Side': 'all-upper-east-side', 'Lenox Hill': 'all-upper-east-side',
  'Yorkville': 'all-upper-east-side', 'Carnegie Hill': 'all-upper-east-side',
  'Upper Carnegie Hill': 'all-upper-east-side', 'Roosevelt Island': 'all-upper-east-side',
  // Manhattan Harlem
  'Harlem': 'harlem', 'East Harlem': 'east-harlem', 'Spanish Harlem': 'east-harlem',
  // Brooklyn
  'Williamsburg': 'williamsburg', 'Greenpoint': 'greenpoint', 'Bushwick': 'bushwick',
  'Bed-Stuy': 'bedford-stuyvesant', 'Bedford-Stuyvesant': 'bedford-stuyvesant',
  'Crown Heights': 'crown-heights', 'Park Slope': 'park-slope',
  'Carroll Gardens': 'carroll-gardens', 'Cobble Hill': 'cobble-hill',
  'Boerum Hill': 'boerum-hill', 'Brooklyn Heights': 'brooklyn-heights',
  'DUMBO': 'dumbo', 'Fort Greene': 'fort-greene', 'Clinton Hill': 'clinton-hill',
  'Prospect Heights': 'prospect-heights', 'Red Hook': 'red-hook',
  'Gowanus': 'gowanus', 'Windsor Terrace': 'windsor-terrace',
  'Bay Ridge': 'bay-ridge', 'Sunset Park': 'sunset-park',
  'Greenwood': 'greenwood', 'Flatbush': 'flatbush', 'Ditmas Park': 'ditmas-park',
  'Kensington': 'kensington', 'Midwood': 'midwood', 'Sheepshead Bay': 'sheepshead-bay',
  'Brighton Beach': 'brighton-beach', 'Coney Island': 'coney-island',
  'Bensonhurst': 'bensonhurst', 'Gravesend': 'gravesend', 'Dyker Heights': 'dyker-heights',
  'Canarsie': 'canarsie', 'Brownsville': 'brownsville', 'East New York': 'east-new-york',
  // Queens
  'Astoria': 'astoria', 'Long Island City': 'long-island-city', 'LIC': 'long-island-city',
  'Sunnyside': 'sunnyside', 'Jackson Heights': 'jackson-heights',
  'Forest Hills': 'forest-hills', 'Rego Park': 'rego-park', 'Flushing': 'flushing',
}

// ── Core API request ──────────────────────────────────────────────────────────
async function seRequest(path: string): Promise<unknown> {
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`
  const res = await fetch(url, {
    headers: {
      'x-rapidapi-key':  RAPIDAPI_KEY,
      'x-rapidapi-host': RAPIDAPI_HOST,
    },
  })
  if (!res.ok) throw new Error(`StreetEasy API ${res.status}: ${path}`)
  return res.json()
}

// ── Live search: query StreetEasy for current market listings ─────────────────
export interface SESearchResult {
  id:           string
  url:          string
  address:      string
  price:        number | null
  beds:         number | null
  baths:        number | null
  sqft:         number | null
  neighborhood: string | null
  status:       string
  daysOnMarket: number | null
  description:  string | null
}

export async function searchStreetEasyListings(params: {
  neighborhoods: string[]
  minBeds?:  number | null
  maxBeds?:  number | null
  minPrice?: number | null
  maxPrice?: number | null
  isRental?: boolean
  limit?:    number
}): Promise<SESearchResult[]> {
  if (!RAPIDAPI_KEY) return []

  const { neighborhoods, minBeds, maxBeds, minPrice, maxPrice, isRental = false, limit = 12 } = params

  // Map neighborhood names → SE area slugs, deduplicate
  const areas = [...new Set(
    neighborhoods.flatMap(n => {
      const slug = NEIGHBORHOOD_TO_SE_AREA[n]
      return slug ? [slug] : []
    })
  )].join(',')

  if (!areas) return []

  const endpoint = isRental ? '/rentals/search' : '/sales/search'
  const qs = new URLSearchParams({ areas, limit: String(limit) })
  if (minBeds  != null) qs.set('minBeds',  String(minBeds))
  if (maxBeds  != null) qs.set('maxBeds',  String(maxBeds))
  if (minPrice != null) qs.set('minPrice', String(minPrice))
  if (maxPrice != null) qs.set('maxPrice', String(maxPrice))

  try {
    const data = await seRequest(`${endpoint}?${qs}`) as { listings?: Record<string, unknown>[] }
    const listings = data.listings ?? []

    return listings
      .filter(l => l.id)
      .map(l => {
        const id = String(l.id)
        return {
          id,
          url:          l.url ? String(l.url) : `https://www.streeteasy.com/${isRental ? 'rental' : 'sale'}/${id}`,
          address:      String(l.address ?? l.fullAddress ?? ''),
          price:        l.price != null ? Number(l.price) : null,
          beds:         l.bedrooms ?? l.beds != null ? Number(l.bedrooms ?? l.beds) : null,
          baths:        l.bathrooms ?? l.baths != null ? Number(l.bathrooms ?? l.baths) : null,
          sqft:         l.sqft ?? l.squareFeet != null ? Number(l.sqft ?? l.squareFeet) : null,
          neighborhood: l.area ?? l.neighborhood != null ? String(l.area ?? l.neighborhood) : null,
          status:       String(l.status ?? 'active'),
          daysOnMarket: l.daysOnMarket != null ? Number(l.daysOnMarket) : null,
          description:  l.description != null ? String(l.description).slice(0, 200) : null,
        }
      })
  } catch {
    return []
  }
}

// ── Get status of a known listing by ID ──────────────────────────────────────
type SEListing = {
  id: string
  status: string
  address?: string
  price?: number
  closedAt?: string
  daysOnMarket?: number
  url?: string   // full StreetEasy listing URL returned by the API
}

export async function getListingById(id: string, type: 'sale' | 'rental' = 'sale'): Promise<SEListing | null> {
  try {
    const path = type === 'rental' ? `/rentals/${id}` : `/sales/${id}`
    const data = await seRequest(path) as SEListing
    return data
  } catch {
    return null
  }
}

// ── Search for a listing by address in a neighborhood ────────────────────────
// Strip unit designator from address before address matching
// "535 Dean Street 204" → "535 Dean Street", "109 Devoe Street GARDEN-2" → "109 Devoe Street"
function stripUnit(address: string): string {
  const STREET_TYPES = /\b(street|avenue|boulevard|road|drive|place|court|lane|terrace|circle|parkway|st|ave|blvd|rd|dr|pl|ct|ln|ter|pkwy)\b\.?/gi
  const matches = [...address.matchAll(STREET_TYPES)]
  if (matches.length === 0) return address
  const last = matches[matches.length - 1]
  return address.slice(0, (last.index ?? 0) + last[0].length).trim()
}

// Borough → ordered list of SE area slugs to try when neighborhood isn't mapped
const BOROUGH_AREAS: Record<string, string[]> = {
  Manhattan: ['all-midtown', 'all-upper-east-side', 'all-upper-west-side', 'all-downtown', 'harlem'],
  Brooklyn:  ['williamsburg', 'park-slope', 'brooklyn-heights', 'bedford-stuyvesant', 'crown-heights', 'fort-greene', 'clinton-hill', 'prospect-heights', 'boerum-hill', 'carroll-gardens', 'cobble-hill', 'dumbo', 'greenpoint', 'bushwick', 'red-hook', 'gowanus'],
  Queens:    ['astoria', 'long-island-city', 'forest-hills', 'jackson-heights', 'flushing', 'sunnyside', 'rego-park'],
  Bronx:     ['riverdale'],
}

async function matchInArea(
  endpoint: string,
  area: string,
  normTarget: string,
  targetNum: string,
  targetStreet: string,
): Promise<SEListing | null> {
  try {
    const data = await seRequest(`${endpoint}?areas=${area}&limit=50`) as { listings?: SEListing[] }
    const listings = data.listings ?? []
    // Exact match
    for (const l of listings) {
      if (!l.address) continue
      if ((normalizeAddress(l.address)?.normalizedFull ?? null) === normTarget) return l
    }
    // Fuzzy: street number + first street word
    for (const l of listings) {
      if (!l.address) continue
      const parts = (normalizeAddress(l.address)?.normalizedFull ?? '').split(' ')
      if (parts[0] === targetNum && parts[1] === targetStreet) return l
    }
  } catch { /* non-fatal */ }
  return null
}

export async function findListingByAddress(
  address: string,
  neighborhood: string | null,
  type: 'sale' | 'rental' = 'sale',
  borough?: string | null,
): Promise<SEListing | null> {
  if (!RAPIDAPI_KEY) return null

  const endpoint = type === 'rental' ? '/rentals/search' : '/sales/search'
  const baseAddress = stripUnit(address)
  const normTarget = normalizeAddress(baseAddress)?.normalizedFull ?? null
  if (!normTarget) return null

  const targetParts = normTarget.split(' ')
  const targetNum    = targetParts[0] ?? ''
  const targetStreet = targetParts[1] ?? ''

  // 1. Try the mapped neighborhood area first
  const primaryArea = neighborhood ? NEIGHBORHOOD_TO_SE_AREA[neighborhood] : null
  if (primaryArea) {
    const found = await matchInArea(endpoint, primaryArea, normTarget, targetNum, targetStreet)
    if (found) return found
  }

  // 2. Try borough fallback areas
  const fallbackAreas = BOROUGH_AREAS[borough ?? ''] ?? BOROUGH_AREAS[neighborhood ? 'Manhattan' : 'Manhattan']
  for (const area of fallbackAreas) {
    if (area === primaryArea) continue  // already tried
    const found = await matchInArea(endpoint, area, normTarget, targetNum, targetStreet)
    if (found) return found
    await new Promise(r => setTimeout(r, 150))  // rate limit
  }

  return null
}

// ── Map SE status to our processingStatus ────────────────────────────────────
function mapStatus(seStatus: string): { streetEasyStatus: string; processingStatus?: string } {
  switch (seStatus?.toLowerCase()) {
    case 'active':
      return { streetEasyStatus: 'active' }
    case 'delisted':
    case 'off market':
      return { streetEasyStatus: 'delisted', processingStatus: 'stale' }
    case 'in contract':
    case 'contract signed':
      return { streetEasyStatus: 'in_contract' }
    case 'closed':
    case 'sold':
      return { streetEasyStatus: 'sold', processingStatus: 'stale' }
    default:
      return { streetEasyStatus: 'unknown' }
  }
}

// ── Check + update a single opportunity ──────────────────────────────────────
export async function syncOpportunityStatus(opportunityId: string): Promise<{
  updated: boolean
  streetEasyStatus: string | null
  previous: string | null
}> {
  const opp = await prisma.extractedOpportunity.findUnique({
    where: { id: opportunityId },
    select: {
      id: true, address: true, neighborhood: true, borough: true, category: true,
      streetEasyId: true, streetEasyStatus: true, transactionType: true,
      processingStatus: true,
    },
  })

  if (!opp || !opp.address) return { updated: false, streetEasyStatus: null, previous: null }
  if (!CHECKABLE_CATEGORIES.has(opp.category)) return { updated: false, streetEasyStatus: null, previous: null }

  const type: 'sale' | 'rental' = opp.transactionType === 'RENTAL' ? 'rental' : 'sale'
  const previous = opp.streetEasyStatus

  let listing: SEListing | null = null

  // Use known ID if we have it
  if (opp.streetEasyId) {
    listing = await getListingById(opp.streetEasyId, type)
  }

  // Otherwise search by address, passing borough for fallback area coverage
  if (!listing) {
    listing = await findListingByAddress(opp.address, opp.neighborhood, type, opp.borough)
  }

  if (!listing) {
    await prisma.extractedOpportunity.update({
      where: { id: opportunityId },
      data: { streetEasyStatus: 'unknown', streetEasyCheckedAt: new Date() },
    })
    return { updated: false, streetEasyStatus: 'unknown', previous }
  }

  const { streetEasyStatus, processingStatus } = mapStatus(listing.status)

  // Prefer the URL path from the API (e.g. "building/newswalk-phase-3/204")
  // over constructing one from the numeric ID — named developments need the slug form.
  let seId = listing.id
  if (listing.url) {
    const m = listing.url.match(/streeteasy\.com\/(.+?)(?:\?.*)?$/)
    if (m) seId = m[1].replace(/\/$/, '')
  }

  await prisma.extractedOpportunity.update({
    where: { id: opportunityId },
    data: {
      streetEasyId:        seId,
      streetEasyStatus,
      streetEasyCheckedAt: new Date(),
      ...(processingStatus ? { processingStatus } : {}),
    },
  })

  const changed = streetEasyStatus !== previous
  return { updated: changed, streetEasyStatus, previous }
}

// ── Shared: cross-reference a list of SE delisted listings against our DB ─────
async function markDelistedMatches(
  delistedListings: SEListing[],
  activeOpps: Array<{ id: string; address: string | null; streetEasyId: string | null }>,
): Promise<number> {
  let count = 0
  for (const delisted of delistedListings) {
    if (!delisted.address) continue
    const normDelisted = normalizeAddress(delisted.address)?.normalizedFull ?? null

    const match = activeOpps.find(o => {
      if (o.streetEasyId === delisted.id) return true
      if (!o.address) return false
      const normOpp = normalizeAddress(o.address)?.normalizedFull ?? null
      return normOpp && normDelisted && normOpp === normDelisted
    })

    if (match) {
      await prisma.extractedOpportunity.update({
        where: { id: match.id },
        data: {
          streetEasyId:        delisted.id,
          streetEasyStatus:    'delisted',
          streetEasyCheckedAt: new Date(),
          processingStatus:    'stale',
        },
      })
      count++
    }
  }
  return count
}

// ── Sweep for recently delisted SALES and RENTALS ────────────────────────────
export async function sweepForDelistings(daysBack = 3): Promise<number> {
  const closedAfter = new Date(Date.now() - daysBack * 86_400_000).toISOString().split('T')[0]

  const SALE_CATS   = ['ACTIVE_SALE_LISTING','OFF_MARKET_SALE','BACK_ON_MARKET','PRICE_DROP',
                       'DEVELOPMENT_INVENTORY','COMING_SOON_DEVELOPMENT','SPONSOR_UNIT','OPEN_HOUSE']
  const RENTAL_CATS = ['RENTAL_LISTING','COMING_SOON_RENTAL']

  const [saleOpps, rentalOpps] = await Promise.all([
    prisma.extractedOpportunity.findMany({
      where: { processingStatus: 'active', category: { in: SALE_CATS as never[] } },
      select: { id: true, address: true, neighborhood: true, streetEasyId: true },
    }),
    prisma.extractedOpportunity.findMany({
      where: { processingStatus: 'active', category: { in: RENTAL_CATS as never[] } },
      select: { id: true, address: true, neighborhood: true, streetEasyId: true },
    }),
  ])

  const saleAreas   = [...new Set(saleOpps.map(o => o.neighborhood && NEIGHBORHOOD_TO_SE_AREA[o.neighborhood]).filter(Boolean) as string[])]
  const rentalAreas = [...new Set(rentalOpps.map(o => o.neighborhood && NEIGHBORHOOD_TO_SE_AREA[o.neighborhood]).filter(Boolean) as string[])]

  let delistedCount = 0

  // Sales delistings
  for (const area of saleAreas) {
    try {
      let offset = 0
      while (true) {
        const data = await seRequest(
          `/sales/past/search?areas=${area}&status=delisted&closedAfter=${closedAfter}&minPrice=100000&limit=50&offset=${offset}`
        ) as { listings?: SEListing[]; pagination?: { nextOffset?: number } }
        const listings = data.listings ?? []
        if (listings.length === 0) break
        delistedCount += await markDelistedMatches(listings, saleOpps)
        if (!data.pagination?.nextOffset) break
        offset = data.pagination.nextOffset
      }
    } catch { /* non-fatal */ }
  }

  // Rental delistings
  for (const area of rentalAreas) {
    try {
      let offset = 0
      while (true) {
        const data = await seRequest(
          `/rentals/past/search?areas=${area}&status=delisted&closedAfter=${closedAfter}&limit=50&offset=${offset}`
        ) as { listings?: SEListing[]; pagination?: { nextOffset?: number } }
        const listings = data.listings ?? []
        if (listings.length === 0) break
        delistedCount += await markDelistedMatches(listings, rentalOpps)
        if (!data.pagination?.nextOffset) break
        offset = data.pagination.nextOffset
      }
    } catch { /* non-fatal */ }
  }

  return delistedCount
}

// ── Sweep for coming-soon that have gone active (sales + rentals) ─────────────
export async function sweepForActivations(): Promise<number> {
  const comingSoon = await prisma.extractedOpportunity.findMany({
    where: {
      processingStatus: 'active',
      category: { in: ['COMING_SOON_DEVELOPMENT', 'COMING_SOON_SALE', 'COMING_SOON_RENTAL'] as never[] },
      address: { not: null },
    },
    select: { id: true, address: true, neighborhood: true, category: true, streetEasyId: true },
  })

  if (comingSoon.length === 0) return 0

  let activatedCount = 0

  for (const opp of comingSoon) {
    try {
      const isRental = opp.category === 'COMING_SOON_RENTAL'
      const type: 'sale' | 'rental' = isRental ? 'rental' : 'sale'

      let listing: SEListing | null = null
      if (opp.streetEasyId) listing = await getListingById(opp.streetEasyId, type)
      if (!listing && opp.address) listing = await findListingByAddress(opp.address, opp.neighborhood, type)

      if (listing && ['active', 'for sale', 'for rent'].includes(listing.status?.toLowerCase() ?? '')) {
        const newCategory =
          opp.category === 'COMING_SOON_DEVELOPMENT' ? 'DEVELOPMENT_INVENTORY' :
          opp.category === 'COMING_SOON_RENTAL'       ? 'RENTAL_LISTING'        :
                                                        'ACTIVE_SALE_LISTING'

        await prisma.extractedOpportunity.update({
          where: { id: opp.id },
          data: {
            category:            newCategory as never,
            streetEasyId:        listing.id,
            streetEasyStatus:    'active',
            streetEasyCheckedAt: new Date(),
          },
        })
        activatedCount++
      }

      await new Promise(r => setTimeout(r, 200))
    } catch { /* non-fatal */ }
  }

  return activatedCount
}

// ── Date-based expiration (no StreetEasy needed) ─────────────────────────────
// Group 3: categories that expire purely based on time
export async function sweepDateExpirations(): Promise<number> {
  const now  = new Date()
  const ago30 = new Date(Date.now() - 30 * 86_400_000)
  let expiredCount = 0

  // OPEN_HOUSE and SHOWING_CONFIRMATION — stale once the event date has passed
  const pastEvents = await prisma.extractedOpportunity.findMany({
    where: {
      processingStatus: 'active',
      category: { in: ['OPEN_HOUSE', 'SHOWING_CONFIRMATION'] as never[] },
      availabilityDate: { not: null, lt: now.toISOString() },
    },
    select: { id: true },
  })

  for (const { id } of pastEvents) {
    await prisma.extractedOpportunity.update({
      where: { id },
      data: { processingStatus: 'stale' },
    })
    expiredCount++
  }

  // COMING_SOON_SALE / COMING_SOON_RENTAL with a past availability date
  // that was never upgraded to active — assume it fell through or was already handled
  const staleComing = await prisma.extractedOpportunity.findMany({
    where: {
      processingStatus: 'active',
      category: { in: ['COMING_SOON_SALE', 'COMING_SOON_RENTAL'] as never[] },
      availabilityDate: { not: null, lt: ago30.toISOString() },
    },
    select: { id: true },
  })

  for (const { id } of staleComing) {
    await prisma.extractedOpportunity.update({
      where: { id },
      data: { processingStatus: 'stale' },
    })
    expiredCount++
  }

  // General staleness: any active supply-side listing older than 90 days
  // with no StreetEasy verification — mark needs_review, not auto-stale
  const ago90 = new Date(Date.now() - 90 * 86_400_000)
  const aged = await prisma.extractedOpportunity.findMany({
    where: {
      processingStatus: 'active',
      category: { in: ['ACTIVE_SALE_LISTING','RENTAL_LISTING','OFF_MARKET_SALE',
                        'BACK_ON_MARKET','PRICE_DROP'] as never[] },
      streetEasyCheckedAt: null,
      createdAt: { lt: ago90 },
    },
    select: { id: true },
  })

  for (const { id } of aged) {
    await prisma.extractedOpportunity.update({
      where: { id },
      data: { processingStatus: 'needs_review' },
    })
    expiredCount++
  }

  return expiredCount
}

// ── Run full daily status sweep ───────────────────────────────────────────────
export async function runDailyStatusSweep(): Promise<{
  checked: number
  updated: number
  delistedFound: number
  activatedFound: number
  expiredFound: number
}> {
  // 1. Sweep for recently delisted (sales + rentals)
  const delistedFound  = await sweepForDelistings(3)

  // 2. Sweep for coming-soon that have gone active (sales + rentals + new dev)
  const activatedFound = await sweepForActivations()

  // 3. Date-based expirations (open houses, stale coming-soons, aged listings)
  const expiredFound   = await sweepDateExpirations()

  // 4. Re-verify individual records not checked in 7+ days
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000)
  const staleChecks = await prisma.extractedOpportunity.findMany({
    where: {
      processingStatus: 'active',
      category: { in: [...CHECKABLE_CATEGORIES] as never[] },
      address: { not: null },
      OR: [
        { streetEasyCheckedAt: null },
        { streetEasyCheckedAt: { lt: sevenDaysAgo } },
      ],
    },
    select: { id: true },
    take: 200,
    orderBy: { streetEasyCheckedAt: 'asc' },
  })

  let updated = 0
  for (const { id } of staleChecks) {
    const result = await syncOpportunityStatus(id)
    if (result.updated) updated++
    await new Promise(r => setTimeout(r, 200))
  }

  return { checked: staleChecks.length, updated, delistedFound, activatedFound, expiredFound }
}

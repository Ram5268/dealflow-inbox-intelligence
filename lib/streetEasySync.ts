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
  // Manhattan broad areas
  'Financial District': 'all-downtown', 'Tribeca': 'all-downtown', 'SoHo': 'all-downtown',
  'NoHo': 'all-downtown', 'Nolita': 'all-downtown', 'Lower East Side': 'all-downtown',
  'Chinatown': 'all-downtown', 'Two Bridges': 'all-downtown', 'Battery Park City': 'all-downtown',
  'Chelsea': 'all-midtown', 'Flatiron': 'all-midtown', 'NoMad': 'all-midtown',
  "Hell's Kitchen": 'all-midtown', 'Gramercy': 'all-midtown', 'Murray Hill': 'all-midtown',
  'Kips Bay': 'all-midtown', 'Midtown': 'all-midtown', 'Midtown West': 'all-midtown',
  'Midtown East': 'all-midtown', 'Hudson Yards': 'all-midtown',
  'Upper West Side': 'all-upper-west-side', 'Morningside Heights': 'all-upper-west-side',
  'Upper East Side': 'all-upper-east-side', 'Yorkville': 'all-upper-east-side',
  'Carnegie Hill': 'all-upper-east-side', 'Lenox Hill': 'all-upper-east-side',
  'Harlem': 'harlem', 'East Harlem': 'east-harlem', 'Washington Heights': 'washington-heights',
  'Inwood': 'inwood',
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

// ── Get status of a known listing by ID ──────────────────────────────────────
type SEListing = {
  id: string
  status: string
  address?: string
  price?: number
  closedAt?: string
  daysOnMarket?: number
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
export async function findListingByAddress(
  address: string,
  neighborhood: string | null,
  type: 'sale' | 'rental' = 'sale',
): Promise<SEListing | null> {
  const area = (neighborhood && NEIGHBORHOOD_TO_SE_AREA[neighborhood]) ?? 'all-downtown'
  const endpoint = type === 'rental' ? '/rentals/search' : '/sales/search'

  try {
    const data = await seRequest(`${endpoint}?areas=${area}&limit=50`) as {
      listings?: SEListing[]
    }
    const listings = data.listings ?? []

    if (listings.length === 0) return null

    // Normalize target address for comparison
    const normTarget = normalizeAddress(address)?.normalizedFull ?? null

    // Find best address match
    for (const listing of listings) {
      if (!listing.address) continue
      const normListing = normalizeAddress(listing.address)?.normalizedFull ?? null
      if (normTarget && normListing && normTarget === normListing) return listing
    }

    // Fuzzy: check if street number + first word of street match
    const targetParts = normTarget?.split(' ') ?? []
    if (targetParts.length >= 2) {
      const targetNum    = targetParts[0]
      const targetStreet = targetParts[1]
      for (const listing of listings) {
        if (!listing.address) continue
        const normListing = normalizeAddress(listing.address)?.normalizedFull ?? null
        const lParts = normListing?.split(' ') ?? []
        if (lParts[0] === targetNum && lParts[1] === targetStreet) return listing
      }
    }

    return null
  } catch {
    return null
  }
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
      id: true, address: true, neighborhood: true, category: true,
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

  // Otherwise search by address
  if (!listing) {
    listing = await findListingByAddress(opp.address, opp.neighborhood, type)
  }

  if (!listing) {
    await prisma.extractedOpportunity.update({
      where: { id: opportunityId },
      data: { streetEasyStatus: 'unknown', streetEasyCheckedAt: new Date() },
    })
    return { updated: false, streetEasyStatus: 'unknown', previous }
  }

  const { streetEasyStatus, processingStatus } = mapStatus(listing.status)

  await prisma.extractedOpportunity.update({
    where: { id: opportunityId },
    data: {
      streetEasyId:        listing.id,
      streetEasyStatus,
      streetEasyCheckedAt: new Date(),
      ...(processingStatus ? { processingStatus } : {}),
    },
  })

  const changed = streetEasyStatus !== previous
  return { updated: changed, streetEasyStatus, previous }
}

// ── Sweep for recently delisted listings by neighborhood ─────────────────────
// Matches delisted results against our active database records
export async function sweepForDelistings(daysBack = 3): Promise<number> {
  const date = new Date(Date.now() - daysBack * 86_400_000)
  const closedAfter = date.toISOString().split('T')[0]

  // Get all unique SE area slugs we have active opportunities in
  const activeOpps = await prisma.extractedOpportunity.findMany({
    where: { processingStatus: 'active', category: { in: [...CHECKABLE_CATEGORIES] as never[] } },
    select: { id: true, address: true, neighborhood: true, streetEasyId: true, transactionType: true },
  })

  const areas = [...new Set(
    activeOpps
      .map(o => o.neighborhood && NEIGHBORHOOD_TO_SE_AREA[o.neighborhood])
      .filter(Boolean) as string[]
  )]

  if (areas.length === 0) return 0

  let delistedCount = 0

  for (const area of areas) {
    try {
      let offset = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const data = await seRequest(
          `/sales/past/search?areas=${area}&status=delisted&closedAfter=${closedAfter}&minPrice=100000&limit=50&offset=${offset}`
        ) as { listings?: SEListing[]; pagination?: { nextOffset?: number; count?: number } }

        const listings = data.listings ?? []
        if (listings.length === 0) break

        // Cross-reference against our active opportunities
        for (const delisted of listings) {
          if (!delisted.address) continue
          const normDelisted = normalizeAddress(delisted.address)?.normalizedFull ?? null

          // Check if we have this listing (by SE ID or address match)
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
            delistedCount++
          }
        }

        if (!data.pagination?.nextOffset) break
        offset = data.pagination.nextOffset
      }
    } catch {
      // Non-fatal — continue to next area
    }
  }

  return delistedCount
}

// ── Run full daily status sweep ───────────────────────────────────────────────
export async function runDailyStatusSweep(): Promise<{
  checked: number
  updated: number
  delistedFound: number
}> {
  // 1. Sweep for recently delisted listings
  const delistedFound = await sweepForDelistings(3)

  // 2. Re-verify any opportunity not checked in 7+ days
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
    take: 50,  // cap per run to stay within rate limits
    orderBy: { streetEasyCheckedAt: 'asc' },
  })

  let updated = 0
  for (const { id } of staleChecks) {
    const result = await syncOpportunityStatus(id)
    if (result.updated) updated++
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200))
  }

  return { checked: staleChecks.length, updated, delistedFound }
}

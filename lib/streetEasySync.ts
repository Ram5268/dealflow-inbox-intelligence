import { prisma } from './prisma'
import { normalizeAddress } from './domain/Address'
import { isTestModeOnly } from './config/testMode'
import { statusUpdateFor, SE_CHECKABLE_CATEGORIES } from './streetEasyStatusUpdate'
import { dateExpiryCutoffs, PAST_EVENT_CATEGORIES, COMING_SOON_EXPIRY_CATEGORIES, AGED_REVIEW_CATEGORIES } from './dateExpiryRules'
import { fetchWithTimeout, isLookupTimeout, LOOKUP_TIMEOUT_MS } from './chat/turnBudget'

// Brief 3.0 follow-up — trial-mode kill switch. In seed-only trial mode there's
// no real inbox flow, so the StreetEasy status sweep has no legitimate work and
// was marking seed test rows 'stale' (draining the demo inventory over time).
// Set STREETEASY_SYNC_ENABLED=false to pause every sweep / stale-marking entry
// point. Flip back to true (the default) once real Microsoft auth + inbox flow
// is connected — see BUGS.md ITERATE. Guards the mutating entry points only;
// the live chat-context search (searchStreetEasyListings) is read-only and stays on.
const SYNC_ENABLED = process.env.STREETEASY_SYNC_ENABLED !== 'false'
if (!SYNC_ENABLED) console.log('[StreetEasy] Sync PAUSED (STREETEASY_SYNC_ENABLED=false).')
// Brief 5.0 — second, independent gate. Either this or !SYNC_ENABLED pauses sync.
const TEST_MODE_SKIP = isTestModeOnly()
if (TEST_MODE_SKIP) console.log('[streetEasySync] skipped: TEST_MODE_ONLY is on')

const RAPIDAPI_KEY  = process.env.RAPIDAPI_KEY  ?? ''
const RAPIDAPI_HOST = process.env.RAPIDAPI_SE_HOST ?? 'nyc-real-estate-api.p.rapidapi.com'
const BASE_URL      = `https://${RAPIDAPI_HOST}`

// Supply-side categories that have real listings to check
const CHECKABLE_CATEGORIES = SE_CHECKABLE_CATEGORIES

// Lat/lng bounding boxes for NYC neighborhoods — used to filter
// broad borough search results down to the specific neighborhood
const NEIGHBORHOOD_BOUNDS: Record<string, [number,number,number,number]> = {
  // [minLat, maxLat, minLng, maxLng]
  'williamsburg':       [40.700, 40.730, -73.975, -73.920],
  'greenpoint':         [40.723, 40.745, -73.960, -73.925],
  'bushwick':           [40.695, 40.720, -73.940, -73.906],
  'bed-stuy':           [40.677, 40.700, -73.960, -73.928],
  'bedford-stuyvesant': [40.677, 40.700, -73.960, -73.928],
  'crown heights':      [40.660, 40.682, -73.960, -73.932],
  'park slope':         [40.660, 40.685, -73.992, -73.963],
  'carroll gardens':    [40.674, 40.690, -74.006, -73.983],
  'cobble hill':        [40.683, 40.695, -74.002, -73.988],
  'boerum hill':        [40.681, 40.693, -73.992, -73.975],
  'brooklyn heights':   [40.691, 40.706, -74.000, -73.983],
  'dumbo':              [40.701, 40.710, -73.993, -73.979],
  'fort greene':        [40.685, 40.700, -73.982, -73.965],
  'clinton hill':       [40.685, 40.700, -73.972, -73.957],
  'prospect heights':   [40.672, 40.685, -73.972, -73.956],
  'red hook':           [40.670, 40.683, -74.020, -74.000],
  'gowanus':            [40.668, 40.682, -73.996, -73.980],
  'astoria':            [40.762, 40.788, -73.940, -73.910],
  'long island city':   [40.735, 40.762, -73.960, -73.930],
}

// NYC neighborhood → StreetEasy area slug mapping for nyc-real-estate-api.p.rapidapi.com
// This API uses borough-level slugs for Brooklyn/Queens, and all-* for Manhattan areas
const NEIGHBORHOOD_TO_SE_AREA: Record<string, string> = {
  // Manhattan — confirmed working area slugs on nyc-real-estate-api
  'Financial District': 'all-downtown', 'FiDi': 'all-downtown',
  'Tribeca': 'all-downtown', 'SoHo': 'all-downtown', 'NoHo': 'all-downtown',
  'Nolita': 'all-downtown', 'Little Italy': 'all-downtown', 'Chinatown': 'all-downtown',
  'Lower East Side': 'all-downtown', 'LES': 'all-downtown',
  'Two Bridges': 'all-downtown', 'Battery Park City': 'all-downtown',
  'Greenwich Village': 'all-downtown', 'West Village': 'all-downtown',
  'East Village': 'all-downtown', 'Hudson Square': 'all-downtown',
  'Chelsea': 'all-midtown', 'West Chelsea': 'all-midtown',
  'Flatiron': 'all-midtown', 'NoMad': 'all-midtown',
  "Hell's Kitchen": 'all-midtown', 'Hells Kitchen': 'all-midtown', 'Clinton': 'all-midtown',
  'Gramercy': 'all-midtown', 'Gramercy Park': 'all-midtown',
  'Murray Hill': 'all-midtown', 'Kips Bay': 'all-midtown',
  'Midtown': 'all-midtown', 'Midtown West': 'all-midtown', 'Midtown East': 'all-midtown',
  'Midtown South': 'all-midtown', 'Hudson Yards': 'all-midtown',
  'Turtle Bay': 'all-midtown', 'Sutton Place': 'all-midtown',
  'Stuyvesant Town': 'all-midtown', 'Peter Cooper Village': 'all-midtown',
  'Upper West Side': 'all-upper-west-side', 'Lincoln Square': 'all-upper-west-side',
  'Manhattan Valley': 'all-upper-west-side', 'Morningside Heights': 'all-upper-west-side',
  'Hamilton Heights': 'all-upper-west-side', 'Washington Heights': 'all-upper-west-side',
  'Inwood': 'all-upper-west-side', 'Manhattanville': 'all-upper-west-side',
  'Upper East Side': 'all-upper-east-side', 'Lenox Hill': 'all-upper-east-side',
  'Yorkville': 'all-upper-east-side', 'Carnegie Hill': 'all-upper-east-side',
  'Upper Carnegie Hill': 'all-upper-east-side', 'Roosevelt Island': 'all-upper-east-side',
  'Harlem': 'all-upper-west-side', 'East Harlem': 'all-upper-east-side',
  // Brooklyn — all use 'brooklyn' slug, filtered by lat/lng bounding box
  'Williamsburg': 'brooklyn', 'Greenpoint': 'brooklyn', 'Bushwick': 'brooklyn',
  'Bed-Stuy': 'brooklyn', 'Bedford-Stuyvesant': 'brooklyn', 'Crown Heights': 'brooklyn',
  'Park Slope': 'brooklyn', 'Carroll Gardens': 'brooklyn', 'Cobble Hill': 'brooklyn',
  'Boerum Hill': 'brooklyn', 'Brooklyn Heights': 'brooklyn', 'DUMBO': 'brooklyn',
  'Fort Greene': 'brooklyn', 'Clinton Hill': 'brooklyn', 'Prospect Heights': 'brooklyn',
  'Red Hook': 'brooklyn', 'Gowanus': 'brooklyn', 'Windsor Terrace': 'brooklyn',
  'Bay Ridge': 'brooklyn', 'Sunset Park': 'brooklyn', 'Greenwood': 'brooklyn',
  'Flatbush': 'brooklyn', 'Ditmas Park': 'brooklyn', 'Kensington': 'brooklyn',
  'Midwood': 'brooklyn', 'Sheepshead Bay': 'brooklyn', 'Brighton Beach': 'brooklyn',
  'Coney Island': 'brooklyn', 'Bensonhurst': 'brooklyn', 'Gravesend': 'brooklyn',
  'Dyker Heights': 'brooklyn', 'Canarsie': 'brooklyn', 'Brownsville': 'brooklyn',
  'East New York': 'brooklyn', 'Downtown Brooklyn': 'brooklyn',
  // Queens — all use 'queens' slug, filtered by lat/lng
  'Astoria': 'queens', 'Long Island City': 'queens', 'LIC': 'queens',
  'Sunnyside': 'queens', 'Jackson Heights': 'queens',
  'Forest Hills': 'queens', 'Rego Park': 'queens', 'Flushing': 'queens',
}

// ── Quota safety rail (Phase X.0) ────────────────────────────────────────────
// Centralized monthly counter + hard pause at 4900/5000 (98% of PRO budget).
// Every RapidAPI call flows through seRequest, so this is the single chokepoint.
// Callers should catch QuotaExhaustedError if they want to skip API-dependent
// work; existing try/catch around sweep/sync functions already swallows it.

export class QuotaExhaustedError extends Error {
  constructor(used: number, budget: number) {
    super(`RapidAPI quota at hard cap: ${used}/${budget} — paused until next month`)
    this.name = 'QuotaExhaustedError'
  }
}

// Distinct from QuotaExhaustedError — this fires when RapidAPI returns HTTP 429
// (rate-limit OR plan-quota-exceeded message). Used by findListingByAddress to
// abandon further area searches for the same record: a 429 on one area means
// every subsequent borough-fallback area will also 429 and waste calls.
export class Rate429Error extends Error {
  constructor(path: string) {
    super(`RapidAPI 429 rate limit on ${path}`)
    this.name = 'Rate429Error'
  }
}

async function checkAndIncrementQuota(): Promise<void> {
  const ym = new Date().toISOString().slice(0, 7)
  const row = await prisma.rapidApiUsage.upsert({
    where:  { yearMonth: ym },
    create: { yearMonth: ym },
    update: {},
  })

  if (row.callsConsumed >= 9500) {
    if (!row.pausedAt) {
      await prisma.rapidApiUsage.update({
        where: { yearMonth: ym },
        data:  { pausedAt: new Date() },
      })
      console.error(`[QUOTA] HARD PAUSE: ${row.callsConsumed}/${row.monthlyBudget} — refusing further RapidAPI calls until next month`)
    }
    throw new QuotaExhaustedError(row.callsConsumed, row.monthlyBudget)
  }

  // Thresholds rebalanced for PRO 10K/month budget. The boolean fields
  // (warnedAt80/90/95) keep their names to avoid a schema migration; their
  // semantic now tracks the SHIFTED warning levels (70/80/90% of 10K).
  // The log message is the authoritative description of what fired.
  //   warnedAt95 ← fires at 9000 (90% of 10K)
  //   warnedAt90 ← fires at 8000 (80% of 10K)
  //   warnedAt80 ← fires at 7000 (70% of 10K)
  const flags: { warnedAt80?: boolean; warnedAt90?: boolean; warnedAt95?: boolean } = {}
  if (row.callsConsumed >= 9000 && !row.warnedAt95) {
    console.warn(`[QUOTA] 90% used: ${row.callsConsumed}/${row.monthlyBudget} — hard pause at 9500`)
    flags.warnedAt95 = true
  } else if (row.callsConsumed >= 8000 && !row.warnedAt90) {
    console.warn(`[QUOTA] 80% used: ${row.callsConsumed}/${row.monthlyBudget}`)
    flags.warnedAt90 = true
  } else if (row.callsConsumed >= 7000 && !row.warnedAt80) {
    console.warn(`[QUOTA] 70% used: ${row.callsConsumed}/${row.monthlyBudget}`)
    flags.warnedAt80 = true
  }

  await prisma.rapidApiUsage.update({
    where: { yearMonth: ym },
    data:  { callsConsumed: { increment: 1 }, ...flags },
  })
}

// ── Core API request ──────────────────────────────────────────────────────────
// Brief 43 PR 4 (M32): the live chat search passes timeoutMs, so a slow
// StreetEasy can't hold up a Drift turn; the sweeps keep their old, unbounded
// wait [engineering precaution].
async function seRequest(path: string, timeoutMs?: number): Promise<unknown> {
  await checkAndIncrementQuota()  // throws QuotaExhaustedError at the hard cap
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`
  const init = {
    headers: {
      'x-rapidapi-key':  RAPIDAPI_KEY,
      'x-rapidapi-host': RAPIDAPI_HOST,
    },
  }
  const res = timeoutMs ? await fetchWithTimeout(url, init, timeoutMs) : await fetch(url, init)
  if (res.status === 429) throw new Rate429Error(path)
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

  // Map neighborhood names → SE area slugs (case-insensitive — chat route passes lowercase)
  const lowerAreaMap: Record<string, string> = Object.fromEntries(
    Object.entries(NEIGHBORHOOD_TO_SE_AREA).map(([k, v]) => [k.toLowerCase(), v])
  )
  const areas = [...new Set(
    neighborhoods.flatMap(n => {
      const slug = lowerAreaMap[n.toLowerCase()] ?? NEIGHBORHOOD_TO_SE_AREA[n]
      return slug ? [slug] : []
    })
  )].join(',')

  if (!areas) {
    console.log('[SE search] no area slugs found for neighborhoods:', neighborhoods)
    return []
  }
  console.log('[SE search] areas:', areas, '| beds:', minBeds, '-', maxBeds, '| price: -', maxPrice)

  const endpoint = isRental ? '/rentals/search' : '/sales/search'
  const qs = new URLSearchParams({ areas, limit: String(limit) })
  if (minBeds  != null) qs.set('minBeds',  String(minBeds))
  if (maxBeds  != null) qs.set('maxBeds',  String(maxBeds))
  if (minPrice != null) qs.set('minPrice', String(minPrice))
  if (maxPrice != null) qs.set('maxPrice', String(maxPrice))

  // Build bounding box from requested neighborhoods for post-filter
  const lowerNeighborhoods = neighborhoods.map(n => n.toLowerCase())
  const bounds = lowerNeighborhoods
    .map(n => NEIGHBORHOOD_BOUNDS[n])
    .filter(Boolean) as [number,number,number,number][]

  try {
    const data = await seRequest(`${endpoint}?${qs}`, LOOKUP_TIMEOUT_MS) as { listings?: Record<string, unknown>[] }
    const listings = data.listings ?? []
    console.log('[SE search] raw results:', listings.length)

    return listings
      .filter(l => {
        if (!l.id) return false
        // Apply bounding box filter if we have bounds for the requested neighborhoods
        if (bounds.length > 0) {
          const lat = Number(l.latitude)
          const lng = Number(l.longitude)
          return bounds.some(([minLat, maxLat, minLng, maxLng]) =>
            lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng
          )
        }
        return true
      })
      .map(l => {
        const id = String(l.id)
        return {
          id,
          url:          String(l.url ?? `https://www.streeteasy.com/${isRental ? 'rental' : 'sale'}/${id}`),
          address:      '',   // not returned in basic search — user gets full details on SE
          price:        l.price != null ? Number(l.price) : null,
          beds:         null, // not returned in basic search
          baths:        null,
          sqft:         null,
          neighborhood: null,
          status:       String(l.status ?? 'open'),
          daysOnMarket: null,
          description:  null,
        }
      })
  } catch (e) {
    // Brief 43 PR 4: a search that ran out of time isn't "no listings"; the
    // chat fetcher says it didn't answer in time.
    if (isLookupTimeout(e)) throw e
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
      if ((normalizeAddress(l.address)?.normalized ?? null) === normTarget) return l
    }
    // Fuzzy: street number + first street word
    for (const l of listings) {
      if (!l.address) continue
      const parts = (normalizeAddress(l.address)?.normalized ?? '').split(' ')
      if (parts[0] === targetNum && parts[1] === targetStreet) return l
    }
  } catch (e) {
    // Re-throw Rate429Error so findListingByAddress can stop the per-record
    // area-fallback loop on the first 429 (every subsequent area will also 429).
    if (e instanceof Rate429Error) throw e
    // All other errors are non-fatal — caller treats as "no match in this area".
  }
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
  const normTarget = normalizeAddress(baseAddress)?.normalized ?? null
  if (!normTarget) return null

  const targetParts = normTarget.split(' ')
  const targetNum    = targetParts[0] ?? ''
  const targetStreet = targetParts[1] ?? ''

  // 1. Try the mapped neighborhood area first
  const primaryArea = neighborhood ? NEIGHBORHOOD_TO_SE_AREA[neighborhood] : null
  if (primaryArea) {
    try {
      const found = await matchInArea(endpoint, primaryArea, normTarget, targetNum, targetStreet)
      if (found) return found
    } catch (e) {
      if (e instanceof Rate429Error) {
        console.warn(`[findListingByAddress] 429 on ${primaryArea} — abandoning further areas for "${address}"`)
        return null
      }
      throw e
    }
  }

  // 2. Try borough fallback areas
  const fallbackAreas = BOROUGH_AREAS[borough ?? ''] ?? BOROUGH_AREAS[neighborhood ? 'Manhattan' : 'Manhattan']
  for (const area of fallbackAreas) {
    if (area === primaryArea) continue  // already tried
    try {
      const found = await matchInArea(endpoint, area, normTarget, targetNum, targetStreet)
      if (found) return found
    } catch (e) {
      if (e instanceof Rate429Error) {
        console.warn(`[findListingByAddress] 429 on ${area} — abandoning further areas for "${address}"`)
        return null
      }
      throw e
    }
    await new Promise(r => setTimeout(r, 150))  // rate limit
  }

  return null
}

// ── Check + update a single opportunity ──────────────────────────────────────
export async function syncOpportunityStatus(opportunityId: string): Promise<{
  updated: boolean
  streetEasyStatus: string | null
  previous: string | null
}> {
  if (!SYNC_ENABLED || TEST_MODE_SKIP) return { updated: false, streetEasyStatus: null, previous: null }
  // Brief 41 (H5): with no key every lookup "misses"; don't record a check.
  if (!RAPIDAPI_KEY) return { updated: false, streetEasyStatus: null, previous: null }

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

  // Brief 41 (H5): only StreetEasy's own status changes the listing. Not
  // finding it (off-market, coming soon, an API error, a 429, the quota) used
  // to mark it delisted + stale; now it records the check time and nothing else.
  const data = statusUpdateFor(listing, new Date())
  await prisma.extractedOpportunity.update({ where: { id: opportunityId }, data })

  const streetEasyStatus = data.streetEasyStatus ?? previous
  return { updated: streetEasyStatus !== previous, streetEasyStatus, previous }
}

// ── Shared: cross-reference a list of SE delisted listings against our DB ─────
async function markDelistedMatches(
  delistedListings: SEListing[],
  activeOpps: Array<{ id: string; address: string | null; streetEasyId: string | null }>,
): Promise<number> {
  let count = 0
  for (const delisted of delistedListings) {
    if (!delisted.address) continue
    const normDelisted = normalizeAddress(delisted.address)?.normalized ?? null

    const match = activeOpps.find(o => {
      if (o.streetEasyId === delisted.id) return true
      if (!o.address) return false
      const normOpp = normalizeAddress(o.address)?.normalized ?? null
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
// Default window widened to 30 days in Phase E — the prior 3-day default
// missed listings older than that, including rentals like 596 Van Buren
// (rented after sitting 6 days). 30 days covers typical short-term rental
// cycles without scanning the entire DB.
export async function sweepForDelistings(daysBack = 30): Promise<number> {
  if (!SYNC_ENABLED || TEST_MODE_SKIP) return 0
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
  if (!SYNC_ENABLED || TEST_MODE_SKIP) return 0
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
// Group 3: categories that expire purely based on time. The rules (categories
// and cutoffs) live in lib/dateExpiryRules.ts, shared with the miss-delisting
// repair (lib/streetEasyMissRepair.ts) so both apply exactly the same rules.
export async function sweepDateExpirations(): Promise<number> {
  if (!SYNC_ENABLED || TEST_MODE_SKIP) return 0
  const cut = dateExpiryCutoffs(new Date())
  let expiredCount = 0

  // OPEN_HOUSE and SHOWING_CONFIRMATION — stale once the event date has passed
  const pastEvents = await prisma.extractedOpportunity.findMany({
    where: {
      processingStatus: 'active',
      category: { in: [...PAST_EVENT_CATEGORIES] as never[] },
      availabilityDate: { not: null, lt: cut.pastEventBefore },
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
      category: { in: [...COMING_SOON_EXPIRY_CATEGORIES] as never[] },
      availabilityDate: { not: null, lt: cut.comingSoonBefore },
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
  const aged = await prisma.extractedOpportunity.findMany({
    where: {
      processingStatus: 'active',
      category: { in: [...AGED_REVIEW_CATEGORIES] as never[] },
      streetEasyCheckedAt: null,
      createdAt: { lt: cut.agedBefore },
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
  if (!SYNC_ENABLED || TEST_MODE_SKIP) return { checked: 0, updated: 0, delistedFound: 0, activatedFound: 0, expiredFound: 0 }

  // 1. Sweep for recently delisted (sales + rentals)
  const delistedFound  = await sweepForDelistings(3)

  // 2. Sweep for coming-soon that have gone active (sales + rentals + new dev)
  const activatedFound = await sweepForActivations()

  // 3. Date-based expirations (open houses, stale coming-soons, aged listings)
  const expiredFound   = await sweepDateExpirations()

  // 4. Re-verify individual records not checked in 7+ days.
  // Sized for RapidAPI PRO tier (~5000 calls/month). Each sweep consumes
  // ~2x this number because sweepForDelistings + sweepForActivations both
  // call the API. At 75: cron uses ~4500 calls/month, leaving ~500 for
  // on-demand syncOpportunityStatus calls from /api/sync/run (Check In).
  //
  // orderBy uses `nulls: 'first'` so never-checked records (streetEasyCheckedAt
  // IS NULL) are processed before previously-checked ones — Postgres' default
  // NULLS LAST for ASC meant new records never got reached when the batch cap
  // was hit (the 596 Van Buren bug pattern).
  //
  // Brief 41 (H5): a lookup that finds nothing no longer delists the listing,
  // so a listing StreetEasy has never found (off-market, coming soon) stays
  // active. It is re-checked every 30 days, not 7, so those can't fill the
  // daily 75 and burn the RapidAPI quota (up to 17 calls per miss).
  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000)
  const staleChecks = await prisma.extractedOpportunity.findMany({
    where: {
      processingStatus: 'active',
      category: { in: [...CHECKABLE_CATEGORIES] as never[] },
      address: { not: null },
      OR: [
        { streetEasyCheckedAt: null },
        { streetEasyId: { not: null }, streetEasyCheckedAt: { lt: sevenDaysAgo } },
        { streetEasyId: null, streetEasyCheckedAt: { lt: thirtyDaysAgo } },
      ],
    },
    select: { id: true },
    take: 75,
    orderBy: { streetEasyCheckedAt: { sort: 'asc', nulls: 'first' } },
  })

  let updated = 0
  for (const { id } of staleChecks) {
    const result = await syncOpportunityStatus(id)
    if (result.updated) updated++
    await new Promise(r => setTimeout(r, 200))
  }

  return { checked: staleChecks.length, updated, delistedFound, activatedFound, expiredFound }
}

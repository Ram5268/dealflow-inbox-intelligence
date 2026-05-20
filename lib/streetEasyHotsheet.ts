// StreetEasy hotsheet fetcher — full rewrite with proper HTML parsing,
// pagination support, and complete field extraction including StreetEasy IDs.

import { prisma } from './prisma'
import { buildOpportunityText, upsertOpportunityEmbedding, semanticSearch } from './embeddings'
import { Category, TransactionType } from '@prisma/client'

export interface HotsheetListing {
  streetEasyId:  string | null   // numeric ID or path slug (e.g. "1829216")
  streetEasyUrl: string | null   // full URL e.g. https://streeteasy.com/sale/1829216
  address:       string
  neighborhood:  string | null
  price:         number | null
  propertyType:  string | null
  beds:          number | null
  baths:         number | null
  sqft:          number | null
  agentNames:    string | null
  brokerage:     string | null
  description:   string | null
  openHouseInfo: string | null
  listingType:   'sale' | 'rental'
}

// ── Fetch a single page ───────────────────────────────────────────────────────
async function fetchPage(url: string): Promise<string> {
  const rememberToken = decodeURIComponent(process.env.SE_REMEMBER_USER_TOKEN ?? '')
  const authToken     = decodeURIComponent(process.env.SE_USER_AUTH_TOKEN ?? '')

  const res = await fetch(url, {
    headers: {
      Cookie: `remember_user_token=${rememberToken}; user_auth_token=${authToken}`,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })

  if (!res.ok) throw new Error(`StreetEasy returned ${res.status} for ${url}`)
  const html = await res.text()

  if (html.includes('Access to this page has been denied') || html.includes('Press & Hold')) {
    throw new Error('StreetEasy bot detection triggered — refresh session cookies in .env')
  }

  return html
}

// ── Parse all listings from one page of HTML ──────────────────────────────────
function parsePage(html: string, type: 'sale' | 'rental'): HotsheetListing[] {
  const listings: HotsheetListing[] = []

  // Each listing starts with <div class='bold'>
  // Split on that marker to get individual listing blocks
  const blocks = html.split("<div class='bold'>").slice(1)

  for (const block of blocks) {
    // ── StreetEasy URL + address ──────────────────────────────────────────────
    const titleM = block.match(/<a class="title" href="(https?:\/\/(?:www\.)?streeteasy\.com\/(sale|rental)\/([^"]+))"[^>]*>\s*([\s\S]*?)\s*<\/a>/)
    if (!titleM) continue

    const streetEasyUrl = titleM[1]
    const pathId        = titleM[3].replace(/\/$/, '').trim()  // "1829216" or "building/name/unit"
    const streetEasyId  = pathId
    const address       = titleM[4].replace(/\s+/g, ' ').trim()

    // ── Neighborhood ─────────────────────────────────────────────────────────
    // First <p> tag after the title link (inside name div)
    const neighborhoodM = block.match(/<a class="title"[\s\S]*?<p>([\s\S]*?)<\/p>/)
    const neighborhood  = neighborhoodM?.[1]?.trim() ?? null

    // ── Price ─────────────────────────────────────────────────────────────────
    const priceM   = block.match(/<div class='price'>\s*\$?([\d,]+)\s*<\/div>/)
    const price    = priceM ? parseFloat(priceM[1].replace(/,/g, '')) : null

    // ── Property type ─────────────────────────────────────────────────────────
    const labelM      = block.match(/<div class='label'>\s*([\s\S]*?)\s*<\/div>/)
    const propertyType = labelM?.[1]?.trim() ?? null

    // ── Beds ──────────────────────────────────────────────────────────────────
    const bedsM = block.match(/<div class='bed'>\s*([\d.]+)\+?\s*beds?\s*<\/div>/i)
    const beds  = bedsM ? parseFloat(bedsM[1]) : null

    // ── Baths ─────────────────────────────────────────────────────────────────
    const bathsM = block.match(/<div class='bath'>\s*([\d.]+)\+?\s*baths?\s*<\/div>/i)
    const baths  = bathsM ? parseFloat(bathsM[1]) : null

    // ── Sqft ──────────────────────────────────────────────────────────────────
    const sqftM = block.match(/<div class='size'>\s*([\d,]+)\s*sqft\s*<\/div>/i)
    const sqft  = sqftM ? parseFloat(sqftM[1].replace(/,/g, '')) : null

    // ── Open house ────────────────────────────────────────────────────────────
    const ohM          = block.match(/<div class='oh'>([\s\S]*?)<\/div>/)
    const openHouseInfo = ohM
      ? ohM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
      : null

    // ── Description ──────────────────────────────────────────────────────────
    // Use hidden-xs div (desktop version). Stop before the "... (more)" link.
    const descM      = block.match(/<div class='hidden-xs'>\s*([\s\S]*?)(?:<a href[^>]*>\.\.\. \(more\)<\/a>|<\/div>)/)
    const description = descM
      ? descM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
      : null

    // ── Agent names + brokerage ───────────────────────────────────────────────
    // Last <p> in the bottom_row — "Agent1, Agent2, Brokerage"
    // Brokerage is the last comma-separated token without a hyperlink
    let agentNames: string | null = null
    let brokerage:  string | null = null

    // Find agent paragraph: contains agent profile links followed by ", BrokerageName"
    const agentParaMatches = [...block.matchAll(/<p>\s*((?:<a[^>]+>[^<]+<\/a>(?:\s*(?:,|and)\s*)?)+),\s*([^<\n]+?)\s*<\/p>/g)]
    if (agentParaMatches.length > 0) {
      const lastMatch = agentParaMatches[agentParaMatches.length - 1]
      agentNames = lastMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      brokerage  = lastMatch[2].trim()
    }

    listings.push({
      streetEasyId, streetEasyUrl, address, neighborhood,
      price, propertyType, beds, baths, sqft,
      agentNames, brokerage, description, openHouseInfo,
      listingType: type,
    })
  }

  return listings
}

// ── Fetch all pages for a given date + type ───────────────────────────────────
async function fetchAllPages(date: string, type: 'sale' | 'rental'): Promise<HotsheetListing[]> {
  const baseUrl  = `https://streeteasy.com/nyc/hotsheets/${type}/${date}`
  const layoutUrl = `${baseUrl}?layout=false`

  // Fetch page 1
  const html1    = await fetchPage(layoutUrl)
  const page1    = parsePage(html1, type)

  // Get total announced count
  const totalM   = html1.match(/<b>(\d+)<\/b>\s*new (?:sales|rentals)/)
  const total    = totalM ? parseInt(totalM[1]) : page1.length
  const perPage  = 50
  const numPages = Math.ceil(total / perPage)

  console.log(`[Hotsheet] ${type} ${date}: ${total} listings across ${numPages} page(s)`)

  if (numPages <= 1) return page1

  const allListings = [...page1]

  for (let p = 2; p <= numPages; p++) {
    try {
      await new Promise(r => setTimeout(r, 400))  // polite delay
      const html = await fetchPage(`${layoutUrl}&page=${p}`)
      const page = parsePage(html, type)
      allListings.push(...page)
      console.log(`[Hotsheet] ${type} ${date}: page ${p}/${numPages} → ${page.length} listings`)
    } catch (err) {
      console.error(`[Hotsheet] Failed page ${p} for ${type} ${date}:`, (err as Error).message)
      break
    }
  }

  return allListings
}

// ── Store listings to DB ──────────────────────────────────────────────────────
async function storeListings(
  listings: HotsheetListing[],
  type: 'sale' | 'rental',
  date: string,
): Promise<{ upserted: number; matches: number }> {
  const category  = type === 'sale' ? Category.ACTIVE_SALE_LISTING : Category.RENTAL_LISTING
  const txType    = type === 'sale' ? TransactionType.SALE         : TransactionType.RENTAL
  const rawEmailId = await getOrCreateHotsheetEmailId()

  let upserted = 0
  let matchCount = 0

  for (const listing of listings) {
    try {
      const title   = `${listing.address}${listing.neighborhood ? ' – ' + listing.neighborhood : ''}`
      const summary = [
        listing.price       ? `$${listing.price.toLocaleString()}` : null,
        listing.beds        ? `${listing.beds}BR`                  : null,
        listing.baths       ? `${listing.baths}BA`                 : null,
        listing.sqft        ? `${listing.sqft.toLocaleString()} sqft` : null,
        listing.propertyType,
        listing.neighborhood,
        listing.brokerage,
        listing.openHouseInfo ? `Open House: ${listing.openHouseInfo}` : null,
        `StreetEasy hotsheet ${date}`,
      ].filter(Boolean).join(' | ')

      const data = {
        rawEmailId,
        category,
        transactionType: txType,
        address:          listing.address,
        neighborhood:     listing.neighborhood,
        price:            listing.price,
        beds:             listing.beds,
        baths:            listing.baths,
        squareFeet:       listing.sqft,
        propertyType:     listing.propertyType,
        sourceAgentName:  listing.agentNames,
        sourceBrokerage:  listing.brokerage,
        extractedTitle:   title,
        extractedSummary: summary,
        classificationReason: `StreetEasy ${type} hotsheet ${date}`,
        confidenceScore:  0.95,
        streetEasyId:     listing.streetEasyId,
        streetEasyStatus: 'active',
      }

      // Prefer upsert by streetEasyId (most reliable) — fall back to address match
      let opp
      if (listing.streetEasyId) {
        const existing = await prisma.extractedOpportunity.findFirst({
          where: { streetEasyId: listing.streetEasyId },
        })
        if (existing) {
          opp = await prisma.extractedOpportunity.update({ where: { id: existing.id }, data })
        } else {
          opp = await prisma.extractedOpportunity.create({ data })
          upserted++
          matchCount += await findBuyerMatches(type, listing)
        }
      } else {
        const existing = await prisma.extractedOpportunity.findFirst({
          where: { address: listing.address, category },
        })
        if (existing) {
          opp = await prisma.extractedOpportunity.update({ where: { id: existing.id }, data })
        } else {
          opp = await prisma.extractedOpportunity.create({ data })
          upserted++
          matchCount += await findBuyerMatches(type, listing)
        }
      }

      upsertOpportunityEmbedding(opp.id, buildOpportunityText({ ...opp })).catch(() => {})
    } catch (e) {
      console.error(`[Hotsheet] Store failed for "${listing.address}":`, (e as Error).message)
    }
  }

  return { upserted, matches: matchCount }
}

// ── Public entry point ────────────────────────────────────────────────────────
export async function runHotsheetSync(dateOverride?: string): Promise<{
  sales: number; rentals: number; matches: number; date: string
}> {
  const d = new Date()
  if (!dateOverride) d.setDate(d.getDate() - 1)
  const date = dateOverride ?? d.toISOString().slice(0, 10)

  console.log(`[Hotsheet] Syncing ${date}`)

  let salesCount   = 0
  let rentalsCount = 0
  let matchCount   = 0

  for (const type of ['sale', 'rental'] as const) {
    try {
      const listings = await fetchAllPages(date, type)
      console.log(`[Hotsheet] ${type} ${date}: fetched ${listings.length} total`)
      const { upserted, matches } = await storeListings(listings, type, date)
      if (type === 'sale') salesCount = upserted
      else rentalsCount = upserted
      matchCount += matches
    } catch (e) {
      console.error(`[Hotsheet] Failed ${type} for ${date}:`, (e as Error).message)
    }
  }

  console.log(`[Hotsheet] Done ${date} — ${salesCount} new sales, ${rentalsCount} new rentals, ${matchCount} buyer matches`)
  return { sales: salesCount, rentals: rentalsCount, matches: matchCount, date }
}

// ── Buyer match detection ─────────────────────────────────────────────────────
async function findBuyerMatches(type: 'sale' | 'rental', listing: HotsheetListing): Promise<number> {
  try {
    const query = [
      type === 'sale' ? 'buyer looking to purchase' : 'renter looking for apartment',
      listing.neighborhood, listing.propertyType,
      listing.price ? `$${listing.price.toLocaleString()}` : '',
      listing.beds  ? `${listing.beds} bedrooms` : '',
    ].filter(Boolean).join(' ')

    const matchIds = await semanticSearch(query, 10)
    const buyers   = await prisma.extractedOpportunity.findMany({
      where: {
        id:          { in: matchIds },
        category:    { in: type === 'sale' ? [Category.BUYER_ISO] : [Category.RENTER_INQUIRY] },
        isDuplicate: false,
      },
    })

    if (buyers.length > 0) {
      console.log(`[Hotsheet] Match: "${listing.address}" → ${buyers.map(b => b.extractedTitle).join(', ')}`)
    }
    return buyers.length
  } catch { return 0 }
}

// ── Synthetic raw email for hotsheet records ──────────────────────────────────
let _hotsheetEmailId: string | null = null
async function getOrCreateHotsheetEmailId(): Promise<string> {
  if (_hotsheetEmailId) return _hotsheetEmailId
  const existing = await prisma.rawEmail.findFirst({
    where:  { graphMessageId: 'streeteasy-hotsheet-synthetic' },
    select: { id: true },
  })
  if (existing) { _hotsheetEmailId = existing.id; return existing.id }
  const created = await prisma.rawEmail.create({
    data: {
      graphMessageId:   'streeteasy-hotsheet-synthetic',
      subject:          'StreetEasy Daily Hotsheet',
      senderEmail:      'noreply@email.streeteasy.com',
      senderName:       'StreetEasy',
      receivedDateTime: new Date(),
      processed:        true,
    },
  })
  _hotsheetEmailId = created.id
  return created.id
}

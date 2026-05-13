// StreetEasy hotsheet fetcher — uses simple HTTP fetch (no browser needed).
// StreetEasy serves full HTML with all listings server-side to logged-in users.
// Runs at 4:54am ET daily using yesterday's date (hotsheet covers prior day's listings).

import { prisma } from './prisma'
import { buildOpportunityText, upsertOpportunityEmbedding, semanticSearch } from './embeddings'
import { Category, TransactionType } from '@prisma/client'

export interface HotsheetListing {
  address: string
  neighborhood: string | null
  price: number | null
  propertyType: string | null
  beds: number | null
  baths: number | null
  sqft: number | null
  agentNames: string | null
  brokerage: string | null
  listingType: 'sale' | 'rental'
}

const PROPERTY_TYPES = ['Co-op', 'Condo', 'Multi-family', 'Townhouse', 'Single-family', 'Land', 'Rental', 'Condop', 'House', 'Loft', 'Apartment', 'Studio']

async function fetchHotsheet(date: string, type: 'sale' | 'rental'): Promise<HotsheetListing[]> {
  const url = `https://streeteasy.com/nyc/hotsheets/${type}/${date}`
  const rememberToken = decodeURIComponent(process.env.SE_REMEMBER_USER_TOKEN ?? '')
  const authToken = decodeURIComponent(process.env.SE_USER_AUTH_TOKEN ?? '')

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

  return parseHotsheetHtml(html, type)
}

function parseHotsheetHtml(html: string, type: 'sale' | 'rental'): HotsheetListing[] {
  // Convert HTML to clean line-by-line text
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')

  // Find the hotsheet section
  const hotsheetStart = text.indexOf('Hotsheet:')
  if (hotsheetStart === -1) return []
  const section = text.slice(hotsheetStart)

  const lines = section.split('\n').map(l => l.trim()).filter(Boolean)
  const listings: HotsheetListing[] = []

  // State machine: address line → neighborhood → price → type → beds → baths → [sqft] → description → agent
  // Matches standard addresses (123 Main) and Queens hyphenated numbers (47-18 Glenwood)
  const addressRe = /^\d+-\d+\s+\w|^\d+\s+\w|^[A-Z]\d+|^\d+\s+[A-Z]/
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Look for a price line — each listing has one
    if (!line.startsWith('$')) { i++; continue }

    const price = parseFloat(line.replace(/[$,]/g, ''))
    if (isNaN(price) || price < 100) { i++; continue }

    // Look back up to 3 lines for address and neighborhood
    let address = ''
    let neighborhood = ''
    if (i >= 2) {
      const prev2 = lines[i - 2]
      const prev1 = lines[i - 1]
      // Address is typically 2 lines back, neighborhood 1 line back
      if (addressRe.test(prev2) && prev2.length < 80) address = prev2
      if (prev1 && prev1.length < 50 && !prev1.startsWith('$') && !/^\d+ beds/.test(prev1)) neighborhood = prev1
    }
    if (!address && i >= 1) {
      const prev1 = lines[i - 1]
      if (addressRe.test(prev1) && prev1.length < 80) address = prev1
    }

    if (!address) { i++; continue }

    // Look forward for type, beds, baths, sqft, agent
    let propertyType: string | null = null
    let beds: number | null = null
    let baths: number | null = null
    let sqft: number | null = null
    let agentNames: string | null = null
    let brokerage: string | null = null

    for (let j = i + 1; j < Math.min(i + 25, lines.length); j++) {
      const l = lines[j]
      if (PROPERTY_TYPES.some(t => l === t)) { propertyType = l; continue }
      const bedsM = l.match(/^([\d.]+)\s+beds?$/)
      if (bedsM) { beds = parseFloat(bedsM[1]); continue }
      const bathsM = l.match(/^([\d.]+)\s+baths?$/)
      if (bathsM) { baths = parseFloat(bathsM[1]); continue }
      const sqftM = l.match(/^([\d,]+)\s+sqft$/)
      if (sqftM) { sqft = parseFloat(sqftM[1].replace(/,/g, '')); continue }
      // Stop at next listing's price
      if (l.startsWith('$') && parseFloat(l.replace(/[$,]/g, '')) > 100) break
      // Agent line: "Name , Name , Brokerage" — always the LAST comma line before next listing.
      // Exclude: open house times, lines starting with digits, lines with too many parts (descriptions).
      // Don't break — keep updating so we end up with the last valid candidate.
      if (
        l.includes(',') &&
        l.length < 150 &&
        !l.startsWith('$') &&
        !/\d+:\d+/.test(l) &&
        !/^\d/.test(l) &&
        !/^(Open House|Price|Showing)/i.test(l)
      ) {
        const parts = l.split(',').map(p => p.trim()).filter(Boolean)
        // 2–7 parts, and the last part (brokerage) should not contain digits
        if (parts.length >= 2 && parts.length <= 7 && !/\d/.test(parts[parts.length - 1])) {
          brokerage = parts[parts.length - 1]
          agentNames = parts.slice(0, -1).join(', ')
        }
      }
    }

    if (address) {
      listings.push({ address, neighborhood, price, propertyType, beds, baths, sqft, agentNames, brokerage, listingType: type })
    }
    i++
  }

  return listings
}

export async function runHotsheetSync(dateOverride?: string): Promise<{ sales: number; rentals: number; matches: number; date: string }> {
  // Hotsheet covers the prior day's new listings
  const d = new Date()
  if (!dateOverride) d.setDate(d.getDate() - 1)
  const date = dateOverride ?? d.toISOString().slice(0, 10)

  console.log(`[StreetEasy] Running hotsheet sync for ${date}`)

  let salesCount = 0
  let rentalsCount = 0
  let matchCount = 0

  for (const type of ['sale', 'rental'] as const) {
    let listings: HotsheetListing[] = []
    try {
      listings = await fetchHotsheet(date, type)
      console.log(`[StreetEasy] Fetched ${listings.length} ${type} listings`)
    } catch (e) {
      console.error(`[StreetEasy] Failed ${type}:`, (e as Error).message)
      continue
    }

    const category = type === 'sale' ? Category.ACTIVE_SALE_LISTING : Category.RENTAL_LISTING
    const txType = type === 'sale' ? TransactionType.SALE : TransactionType.RENTAL

    for (const listing of listings) {
      try {
        const title = `${listing.address}${listing.neighborhood ? ' – ' + listing.neighborhood : ''}`
        const summary = [
          listing.price ? `$${listing.price.toLocaleString()}` : null,
          listing.beds ? `${listing.beds}BR` : null,
          listing.baths ? `${listing.baths}BA` : null,
          listing.sqft ? `${listing.sqft.toLocaleString()}sqft` : null,
          listing.propertyType,
          listing.neighborhood,
          listing.brokerage,
          `StreetEasy hotsheet ${date}`,
        ].filter(Boolean).join(' | ')

        const data = {
          rawEmailId: await getOrCreateHotsheetEmailId(),
          category, transactionType: txType,
          address: listing.address, neighborhood: listing.neighborhood,
          price: listing.price, beds: listing.beds, baths: listing.baths,
          squareFeet: listing.sqft, propertyType: listing.propertyType,
          sourceAgentName: listing.agentNames, sourceBrokerage: listing.brokerage,
          extractedTitle: title, extractedSummary: summary,
          classificationReason: `StreetEasy ${type} hotsheet ${date}`,
          confidenceScore: 0.95,
        }

        const existing = await prisma.extractedOpportunity.findFirst({
          where: { address: listing.address, category, createdAt: { gte: new Date(date) } },
        })

        let opp
        if (existing) {
          // Update with freshly-parsed data so re-runs always self-correct
          opp = await prisma.extractedOpportunity.update({ where: { id: existing.id }, data })
        } else {
          opp = await prisma.extractedOpportunity.create({ data })
          type === 'sale' ? salesCount++ : rentalsCount++
          matchCount += await findBuyerMatches(type, listing)
        }

        upsertOpportunityEmbedding(opp.id, buildOpportunityText({ ...opp })).catch(() => {})
      } catch (e) {
        console.error(`[StreetEasy] Store failed for "${listing.address}":`, (e as Error).message)
      }
    }
  }

  console.log(`[StreetEasy] Done — ${salesCount} sales, ${rentalsCount} rentals, ${matchCount} buyer matches`)
  return { sales: salesCount, rentals: rentalsCount, matches: matchCount, date }
}

async function findBuyerMatches(type: 'sale' | 'rental', listing: HotsheetListing): Promise<number> {
  try {
    const query = [
      type === 'sale' ? 'buyer looking to purchase' : 'renter looking for apartment',
      listing.neighborhood, listing.propertyType,
      listing.price ? `$${listing.price.toLocaleString()}` : '',
      listing.beds ? `${listing.beds} bedrooms` : '',
    ].filter(Boolean).join(' ')

    const matchIds = await semanticSearch(query, 10)
    const buyers = await prisma.extractedOpportunity.findMany({
      where: {
        id: { in: matchIds },
        category: { in: type === 'sale' ? [Category.BUYER_ISO] : [Category.RENTER_INQUIRY] },
        isDuplicate: false,
      },
    })
    if (buyers.length > 0) {
      console.log(`[StreetEasy] Match: "${listing.address}" → ${buyers.map(b => b.extractedTitle).join(', ')}`)
    }
    return buyers.length
  } catch { return 0 }
}

let _hotsheetEmailId: string | null = null
async function getOrCreateHotsheetEmailId(): Promise<string> {
  if (_hotsheetEmailId) return _hotsheetEmailId
  const existing = await prisma.rawEmail.findFirst({ where: { graphMessageId: 'streeteasy-hotsheet-synthetic' }, select: { id: true } })
  if (existing) { _hotsheetEmailId = existing.id; return existing.id }
  const created = await prisma.rawEmail.create({
    data: { graphMessageId: 'streeteasy-hotsheet-synthetic', subject: 'StreetEasy Daily Hotsheet', senderEmail: 'noreply@email.streeteasy.com', senderName: 'StreetEasy', receivedDateTime: new Date(), processed: true },
  })
  _hotsheetEmailId = created.id
  return created.id
}

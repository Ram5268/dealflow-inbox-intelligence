// Parses StreetEasy daily hotsheet emails into ExtractedOpportunity records.
// Two email types arrive each morning around 4:55am:
//   1. "Hotsheet: N New Sales | N New Rentals" — new listings preview
//   2. "Hotsheet: N New Recorded Sales"        — closed transactions
// No AI needed — pure regex, zero API cost.

import { prisma } from '../../prisma'
import { Category, TransactionType } from '@prisma/client'

export function isHotsheetEmail(subject: string, senderEmail: string): boolean {
  return (
    /hotsheet/i.test(subject) &&
    senderEmail.toLowerCase().includes('streeteasy')
  )
}

interface ParsedListing {
  address:      string
  price:        number | null
  beds:         number | null
  baths:        number | null
  sqft:         number | null
  neighborhood: string | null
  propertyType: string | null
  agentName:    string | null
  brokerage:    string | null
  soldDate:     string | null
  buyers:       string | null
  sellers:      string | null
  listingType:  'sale' | 'rental' | 'recorded_sale'
}

// ── Parse "N New Sales | N New Rentals" email ─────────────────────────────────
function parseNewListingsEmail(body: string): ParsedListing[] {
  const listings: ParsedListing[] = []

  // Split into sale and rental sections
  const salesSection   = body.split(/SEE \d+ NEW SALES/i)[0]   ?? body
  const rentalsSection = body.split(/SEE \d+ NEW SALES/i)[1]?.split(/SEE \d+ NEW RENTALS/i)[0] ?? ''

  for (const [section, listingType] of [[salesSection, 'sale'], [rentalsSection, 'rental']] as const) {
    if (!section.trim()) continue

    // Each listing block: ADDRESS $PRICE\n...details
    // Addresses appear in ALL CAPS before the price
    const blocks = section.split(/(?=[A-Z0-9 ]{5,}\s+\$[\d,]+)/).filter(b => /\$[\d,]+/.test(b))

    for (const block of blocks) {
      const priceM  = block.match(/\$(\d[\d,]+)/)
      const price   = priceM ? parseFloat(priceM[1].replace(/,/g, '')) : null

      // Address is everything before the price on the first line
      const firstLine = block.split('\n')[0] ?? block.split('$')[0]
      const address   = firstLine.replace(/\$[\d,]+.*/, '').trim().replace(/&nbsp;/g, ' ').trim()
      if (!address || address.length < 4) continue

      const bedsM  = block.match(/(\d+(?:\.\d+)?)\s*Bed/)
      const bathsM = block.match(/(\d+(?:\.\d+)?(?:\+)?)\s*Bath/)
      const sqftM  = block.match(/([\d,]+)ft²/)

      const beds  = bedsM  ? parseFloat(bedsM[1])  : null
      const baths = bathsM ? parseFloat(bathsM[1]) : null
      const sqft  = sqftM  ? parseFloat(sqftM[1].replace(/,/g, '')) : null

      // "Condo in Lenox Hill" or "Townhouse in Cobble Hill"
      const propNeighM = block.match(/([A-Z][a-zA-Z\s]+)\s+in\s+([A-Z][a-zA-Z\s]+?)(?:\s+[A-Z][a-z]|\s*(?:Listing|$))/)
      const propertyType = propNeighM?.[1]?.trim() ?? null
      const neighborhood = propNeighM?.[2]?.trim() ?? null

      // "Listing by BROKERAGE (address)"
      const brokerageM = block.match(/Listing by ([^(]+?)(?:\s*\(|$)/)
      const brokerage  = brokerageM?.[1]?.trim() ?? null

      // Agent names appear before "Listing by" — comma/space separated names
      const agentSection = block.split(/Listing by/i)[0]
      const agentLines   = agentSection.split('\n').filter(l => l.includes(',') || /[A-Z][a-z]+ [A-Z]/.test(l))
      const agentName    = agentLines[agentLines.length - 1]?.replace(/\s+,\s+/g, ', ').trim() ?? null

      listings.push({ address, price, beds, baths, sqft, neighborhood, propertyType, agentName, brokerage, soldDate: null, buyers: null, sellers: null, listingType })
    }
  }

  return listings
}

// ── Parse "N New Recorded Sales" email ────────────────────────────────────────
function parseRecordedSalesEmail(body: string): ParsedListing[] {
  const listings: ParsedListing[] = []

  // Recorded sales format:
  //   ADDRESS #UNIT $PRICE
  //   Sold: Month DD, YYYY
  //   Property type in Neighborhood
  //   Buyers: ...
  //   Sellers: ...

  const blocks = body.split(/(?=\d+ [A-Z][\w\s]+ (?:#[\w]+ )?\$[\d,]+)/).filter(b => /Sold:/i.test(b) || /Buyer/i.test(b))

  for (const block of blocks) {
    const priceM   = block.match(/\$(\d[\d,]+)/)
    const price    = priceM ? parseFloat(priceM[1].replace(/,/g, '')) : null

    const addressLine = block.split('\n')[0] ?? ''
    const address     = addressLine.replace(/\$[\d,]+.*/, '').trim()
    if (!address || address.length < 4) continue

    const soldM   = block.match(/Sold:\s*([\w]+ \d+, \d+)/i)
    const soldDate = soldM?.[1] ?? null

    const propNeighM = block.match(/([A-Z][a-zA-Z\s-]+)\s+in\s+([A-Z][a-zA-Z\s]+?)(?:\n|Buyer|Seller|Listing|$)/)
    const propertyType = propNeighM?.[1]?.trim() ?? null
    const neighborhood = propNeighM?.[2]?.trim() ?? null

    const buyersM  = block.match(/Buyers?:\s*(.+?)(?:\n|Sellers?:|$)/i)
    const sellersM = block.match(/Sellers?:\s*(.+?)(?:\n|Listing|$)/i)

    const brokerageM = block.match(/Listing by ([^(]+?)(?:\s*\(|$)/i)

    listings.push({
      address,
      price,
      beds: null, baths: null, sqft: null,
      neighborhood,
      propertyType,
      agentName:  null,
      brokerage:  brokerageM?.[1]?.trim() ?? null,
      soldDate,
      buyers:     buyersM?.[1]?.trim()  ?? null,
      sellers:    sellersM?.[1]?.trim() ?? null,
      listingType: 'recorded_sale',
    })
  }

  return listings
}

// ── Store parsed listings as ExtractedOpportunity ────────────────────────────
export async function processHotsheetEmail(rawEmailId: string, subject: string, body: string): Promise<number> {
  const isRecordedSales = /recorded sales/i.test(subject)

  const listings = isRecordedSales
    ? parseRecordedSalesEmail(body)
    : parseNewListingsEmail(body)

  if (listings.length === 0) return 0

  let stored = 0

  for (const l of listings) {
    if (!l.address) continue

    const category: Category =
      l.listingType === 'recorded_sale' ? Category.ACTIVE_SALE_LISTING :
      l.listingType === 'rental'        ? Category.RENTAL_LISTING :
                                          Category.ACTIVE_SALE_LISTING

    const txType: TransactionType =
      l.listingType === 'rental' ? TransactionType.RENTAL : TransactionType.SALE

    const title   = `${l.address}${l.price ? ` — $${l.price.toLocaleString()}` : ''}`
    const summary = [
      l.listingType === 'recorded_sale' ? 'Recorded sale' : 'New listing',
      l.neighborhood,
      l.propertyType,
      l.beds  ? `${l.beds}BR` : null,
      l.baths ? `${l.baths}BA` : null,
      l.soldDate ? `Sold ${l.soldDate}` : null,
      l.buyers  ? `Buyer: ${l.buyers.slice(0, 80)}`  : null,
      l.sellers ? `Seller: ${l.sellers.slice(0, 80)}` : null,
      l.brokerage,
    ].filter(Boolean).join(' · ')

    try {
      // Deduplicate by rawEmailId + address
      const existing = await prisma.extractedOpportunity.findFirst({
        where: { rawEmailId, address: l.address },
      })
      if (existing) continue

      await prisma.extractedOpportunity.create({
        data: {
          rawEmailId,
          category,
          transactionType:      txType,
          address:              l.address,
          neighborhood:         l.neighborhood,
          price:                l.price,
          beds:                 l.beds,
          baths:                l.baths,
          squareFeet:           l.sqft,
          propertyType:         l.propertyType,
          sourceAgentName:      l.agentName,
          sourceBrokerage:      l.brokerage,
          availabilityDate:     l.soldDate,
          extractedTitle:       title,
          extractedSummary:     summary,
          classificationReason: `StreetEasy hotsheet email — ${isRecordedSales ? 'recorded sale' : l.listingType}`,
          confidenceScore:      0.95,
          processingStatus:     'active',
        },
      })
      stored++
    } catch { /* skip duplicates */ }
  }

  // Mark the raw email as processed
  await prisma.rawEmail.update({
    where: { id: rawEmailId },
    data: { processed: true, extractionStatus: 'extracted', classifierCategory: 'HOTSHEET' },
  })

  return stored
}

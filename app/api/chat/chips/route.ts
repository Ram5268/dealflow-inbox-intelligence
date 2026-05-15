export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000)

  const [recent, priceDrop, buyerISO, comingSoon, offMarket, rentalNew] = await Promise.all([
    prisma.extractedOpportunity.count({
      where: { isDuplicate: false, createdAt: { gte: since24h } },
    }),
    prisma.extractedOpportunity.count({
      where: { isDuplicate: false, category: 'PRICE_DROP', createdAt: { gte: since48h } },
    }),
    prisma.extractedOpportunity.count({
      where: { isDuplicate: false, category: 'BUYER_ISO', createdAt: { gte: since48h } },
    }),
    prisma.extractedOpportunity.count({
      where: { isDuplicate: false, category: 'COMING_SOON_SALE', createdAt: { gte: since48h } },
    }),
    prisma.extractedOpportunity.count({
      where: { isDuplicate: false, category: 'OFF_MARKET_SALE', createdAt: { gte: since48h } },
    }),
    prisma.extractedOpportunity.count({
      where: { isDuplicate: false, category: 'RENTAL_LISTING', createdAt: { gte: since48h } },
    }),
  ])

  const chips: { label: string; query: string }[] = []

  // Always lead with what came in recently
  if (recent > 0) {
    chips.push({
      label: `${recent} new ${recent === 1 ? 'opportunity' : 'opportunities'} overnight`,
      query: `What new opportunities came in over the last 24 hours? Summarize them.`,
    })
  }

  if (comingSoon > 0) {
    chips.push({
      label: `${comingSoon} coming soon listing${comingSoon > 1 ? 's' : ''}`,
      query: `Show me the coming soon listings from the last 48 hours.`,
    })
  }

  if (offMarket > 0) {
    chips.push({
      label: `${offMarket} off-market deal${offMarket > 1 ? 's' : ''}`,
      query: `Show me the off-market deals from the last 48 hours.`,
    })
  }

  if (priceDrop > 0) {
    chips.push({
      label: `${priceDrop} price drop${priceDrop > 1 ? 's' : ''}`,
      query: `What price drops came in recently? Show me the details.`,
    })
  }

  if (buyerISO > 0) {
    chips.push({
      label: `${buyerISO} buyer ISO${buyerISO > 1 ? 's' : ''} to match`,
      query: `Show me recent buyer ISOs — what are they looking for and do any match my listings?`,
    })
  }

  if (rentalNew > 0) {
    chips.push({
      label: `${rentalNew} new rental${rentalNew > 1 ? 's' : ''}`,
      query: `Show me the new rental listings from the last 48 hours.`,
    })
  }

  // Fallback chips if database is empty or nothing recent
  if (chips.length === 0) {
    chips.push(
      { label: 'What came in this week?', query: 'Summarize everything that came into my inbox this week.' },
      { label: 'Coming soon listings', query: 'Show me all coming soon listings in the database.' },
      { label: 'Buyer ISO matches', query: 'Show me all buyer ISOs and check if any match my current listings.' },
      { label: 'Off-market deals', query: 'Show me all off-market deals in my inbox.' },
    )
  }

  // Cap at 4
  return NextResponse.json({ chips: chips.slice(0, 4) })
}

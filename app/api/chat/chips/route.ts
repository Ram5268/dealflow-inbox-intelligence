export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { buildChips } from '@/lib/chat/chips'

// Brief 43 PR 14 (Q29, M21): the chips' wording lives in lib/chat/chips.ts.
// No price-drop chip any more (search can't find price drops), so no count for it.
export async function GET() {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000)

  const [recent, buyerISO, comingSoonOrOffMarket, rentalNew] = await Promise.all([
    prisma.extractedOpportunity.count({
      where: { isDuplicate: false, createdAt: { gte: since24h } },
    }),
    prisma.extractedOpportunity.count({
      where: { isDuplicate: false, category: 'BUYER_ISO', createdAt: { gte: since48h } },
    }),
    prisma.extractedOpportunity.count({
      where: {
        isDuplicate: false,
        category:    { in: ['COMING_SOON_SALE', 'OFF_MARKET_SALE'] },
        createdAt:   { gte: since24h },
      },
    }),
    prisma.extractedOpportunity.count({
      where: { isDuplicate: false, category: 'RENTAL_LISTING', createdAt: { gte: since48h } },
    }),
  ])

  return NextResponse.json({ chips: buildChips({ recent, comingSoonOrOffMarket, buyerISO, rentalNew }) })
}

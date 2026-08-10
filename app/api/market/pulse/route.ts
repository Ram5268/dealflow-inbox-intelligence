export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { Category } from '@prisma/client'

// Brief 7.4 (Section D) — Market Signal Meter. Aggregates the last 7 days of
// extracted opportunities by neighborhood into supply (new listings) vs demand
// (new ISOs), rates each neighborhood HOT/WARM/COLD, and returns the top 3 by
// combined activity for a pulse row on Home.

const LISTING_CATS = new Set<string>([
  Category.ACTIVE_SALE_LISTING, Category.RENTAL_LISTING, Category.COMING_SOON_SALE,
  Category.COMING_SOON_RENTAL, Category.OFF_MARKET_SALE, Category.PRICE_DROP,
  Category.BACK_ON_MARKET, Category.DEVELOPMENT_INVENTORY, Category.COMING_SOON_DEVELOPMENT,
  Category.SPONSOR_UNIT,
])
const ISO_CATS = new Set<string>([Category.BUYER_ISO, Category.RENTER_INQUIRY])

type Heat = 'HOT' | 'WARM' | 'COLD'
function heatOf(newListings: number, newISOs: number): Heat {
  if (newListings > 10 || newISOs > 5) return 'HOT'
  if (newListings >= 5 || newISOs >= 2) return 'WARM'
  return 'COLD'
}

export async function GET() {
  const organizationId = await getCurrentOrgId()
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)

  const rows = await prisma.extractedOpportunity.findMany({
    where: {
      organizationId,
      isDuplicate: false,
      createdAt: { gte: since },
      neighborhood: { not: null },
    },
    select: { neighborhood: true, category: true },
  })

  const agg = new Map<string, { newListings: number; newISOs: number }>()
  for (const r of rows) {
    const name = (r.neighborhood ?? '').trim()
    if (!name) continue
    const a = agg.get(name) ?? { newListings: 0, newISOs: 0 }
    if (LISTING_CATS.has(r.category)) a.newListings++
    else if (ISO_CATS.has(r.category)) a.newISOs++
    else continue // informational/lead categories don't move the market meter
    agg.set(name, a)
  }

  const neighborhoods = [...agg.entries()]
    .map(([name, a]) => ({ name, heat: heatOf(a.newListings, a.newISOs), newListings: a.newListings, newISOs: a.newISOs }))
    .sort((x, y) => (y.newListings + y.newISOs) - (x.newListings + x.newISOs))
    .slice(0, 3)

  return NextResponse.json({ neighborhoods })
}

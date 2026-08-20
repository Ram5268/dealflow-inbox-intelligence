export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { Category } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'

// GET /api/reports/available-buyers — demand parties eligible for a Buyer Match
// report (BUYER_ISO / RENTER_INQUIRY opportunities), with persisted-Match counts
// per Brief 27's semantic (read the Match table, never re-run the matcher).
// Cap 200, newest first. Match counts: hot = HOT, warm = WARM, near = POSSIBLE.

function money(n: number | null): string | null {
  if (n == null || Number.isNaN(n)) return null
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `$${Math.round(n / 1000)}K`
  return `$${Math.round(n)}`
}

function bedsLabel(min: number | null, max: number | null, exact: number | null): string | null {
  if (exact != null) return exact === 0 ? 'studio' : `${exact}BR`
  if (min == null && max == null) return null
  if (min != null && max != null) return min === max ? `${min}BR` : `${min}-${max}BR`
  return min != null ? `${min}BR+` : `up to ${max}BR`
}

function criteriaSummary(o: {
  neighborhoods: string[]; neighborhood: string | null; borough: string | null
  minBeds: number | null; maxBeds: number | null; beds: number | null
  minPrice: number | null; maxPrice: number | null; price: number | null
}): string {
  const hoods = o.neighborhoods.length ? o.neighborhoods.join('/') : o.neighborhood ?? o.borough ?? ''
  const beds = bedsLabel(o.minBeds, o.maxBeds, o.beds)
  const lo = money(o.minPrice)
  const hi = money(o.maxPrice ?? o.price)
  const price = lo && hi ? `${lo}-${hi}` : hi ?? lo ?? ''
  return [beds, hoods, price].filter(Boolean).join(' · ') || 'no criteria on file'
}

export async function GET() {
  try {
    const organizationId = await getCurrentOrgId()

    const opps = await prisma.extractedOpportunity.findMany({
      where: {
        organizationId,
        category: { in: [Category.BUYER_ISO, Category.RENTER_INQUIRY] },
        isDuplicate: false,
        processingStatus: 'active',
      },
      select: {
        id: true, category: true, extractedTitle: true,
        neighborhoods: true, neighborhood: true, borough: true,
        minBeds: true, maxBeds: true, beds: true,
        minPrice: true, maxPrice: true, price: true, updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    })

    // One grouped query for all match counts (avoids N+1 per buyer).
    const ids = opps.map(o => o.id)
    const groups = ids.length
      ? await prisma.match.groupBy({
          by: ['counterpartId', 'tier'],
          where: { counterpartId: { in: ids }, counterpartType: 'opportunity' },
          _count: true,
        })
      : []
    const counts = new Map<string, { hot: number; warm: number; near: number }>()
    for (const g of groups) {
      const c = counts.get(g.counterpartId) ?? { hot: 0, warm: 0, near: 0 }
      if (g.tier === 'HOT') c.hot += g._count
      else if (g.tier === 'WARM') c.warm += g._count
      else if (g.tier === 'POSSIBLE') c.near += g._count
      counts.set(g.counterpartId, c)
    }

    const buyers = opps.map(o => ({
      id: o.id,
      displayName: o.extractedTitle || `${o.category === Category.RENTER_INQUIRY ? 'Renter' : 'Buyer'} ISO`,
      criteriaSummary: criteriaSummary(o),
      matchCount: counts.get(o.id) ?? { hot: 0, warm: 0, near: 0 },
      updatedAt: o.updatedAt.toISOString(),
    }))

    return NextResponse.json({ buyers })
  } catch (err) {
    console.error('[reports/available-buyers] error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

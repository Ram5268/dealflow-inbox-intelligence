export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'

// GET /api/debug/guard-fires — Brief 11.0, Fix #2. Guard-fire audit for
// post-deploy dogfooding: the last N GuardFireEvent rows plus a verdict
// breakdown, so Ryan can see how often the hallucination guard fires and which
// class of outcome (pass / retry / canned_fallback) dominates. No auth
// (localhost + solo prod), best-effort — a query failure returns empty rather
// than blanking the page. ?limit=N (default 50, max 500).
export async function GET(req: NextRequest) {
  const orgId = await getCurrentOrgId().catch(() => '')
  const limitParam = Number(req.nextUrl.searchParams.get('limit'))
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 500) : 50

  try {
    const [events, grouped] = await Promise.all([
      prisma.guardFireEvent.findMany({
        where: orgId ? { organizationId: orgId } : {},
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.guardFireEvent.groupBy({
        by: ['verifierVerdict'],
        where: orgId ? { organizationId: orgId } : {},
        _count: { _all: true },
      }),
    ])

    const byVerdict: Record<string, number> = {}
    for (const g of grouped) byVerdict[g.verifierVerdict] = g._count._all

    return NextResponse.json({
      total: Object.values(byVerdict).reduce((a, b) => a + b, 0),
      byVerdict,
      count: events.length,
      events,
    })
  } catch (err) {
    console.error('[guard-fires] query failed:', err)
    return NextResponse.json({ total: 0, byVerdict: {}, count: 0, events: [], error: String(err) })
  }
}

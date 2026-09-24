export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { getTodayQueue } from '@/lib/ranking/queueRead'

// Brief 33 — read the latest persisted queue. ?limit= (default 50, max 200).
export async function GET(req: NextRequest) {
  const orgId = await getCurrentOrgId()
  const raw = parseInt(req.nextUrl.searchParams.get('limit') ?? '50', 10)
  const limit = Math.min(Math.max(1, Number.isNaN(raw) ? 50 : raw), 200)
  const view = await getTodayQueue(orgId, limit)
  return NextResponse.json(view)
}

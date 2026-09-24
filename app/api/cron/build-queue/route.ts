export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { buildCallQueue } from '@/lib/ranking/queueBuilder'

// Brief 33 — nightly call-queue regen. Scheduled externally (QStash / Vercel Cron)
// for 5am ET daily (0 10 * * * UTC; DST fudge accepted for MVP — the schedule
// config lives outside code). Secured by CRON_SECRET, mirroring /api/sync/run.
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true // local/dev — allow
  const auth = req.headers.get('authorization')
  if (auth === `Bearer ${secret}`) return true
  if (req.nextUrl.searchParams.get('secret') === secret) return true
  return false
}

async function run(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const orgId = await getCurrentOrgId()
  const { stats, generationRunId } = await buildCallQueue(orgId, 50, true)
  return NextResponse.json({ ok: true, generationRunId, ...stats })
}

export async function GET(req: NextRequest) { return run(req) }
export async function POST(req: NextRequest) { return run(req) }

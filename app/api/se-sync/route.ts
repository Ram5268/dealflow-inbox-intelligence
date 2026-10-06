export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { runDailyStatusSweep, syncOpportunityStatus } from '@/lib/streetEasySync'
import { checkCronBearer } from '@/lib/auth/cronBearer'

// POST /api/se-sync              → run full daily sweep
// POST /api/se-sync?id=<oppId>   → check one specific opportunity
// Protected by `Authorization: Bearer <CRON_SECRET>` (GitHub's daily-sweep
// workflow). Brief 41 (L1): checkCronBearer, so it fails closed when the
// secret is unset.
export async function POST(req: NextRequest) {
  const auth = checkCronBearer(req.headers.get('authorization'), process.env.CRON_SECRET)
  if (auth !== 200) {
    return NextResponse.json({ error: auth === 500 ? 'CRON_SECRET not configured' : 'unauthorized' }, { status: auth })
  }

  if (!process.env.RAPIDAPI_KEY) {
    return NextResponse.json({ error: 'RAPIDAPI_KEY not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')

  try {
    if (id) {
      const result = await syncOpportunityStatus(id)
      return NextResponse.json({ ok: true, ...result })
    }

    const result = await runDailyStatusSweep()
    console.log('[se-sync]', result)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[se-sync]', err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}

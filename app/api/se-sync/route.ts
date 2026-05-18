export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { runDailyStatusSweep, syncOpportunityStatus } from '@/lib/streetEasySync'

// POST /api/se-sync              → run full daily sweep
// POST /api/se-sync?id=<oppId>   → check one specific opportunity
export async function POST(req: NextRequest) {
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

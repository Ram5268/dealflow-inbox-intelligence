export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { runIncrementalSync } from '@/lib/backgroundSync'
import { prisma } from '@/lib/prisma'

// Internal route — only calls Microsoft Graph GET requests externally.
export async function POST() {
  const isFirst = (await prisma.rawEmail.count()) === 0

  const result = await runIncrementalSync()

  // After inbox sync, run a StreetEasy status sweep so manual Check In also
  // refreshes stale listing status alongside fresh emails (Phase E). Non-fatal:
  // a sweep failure does not block the inbox sync result.
  try {
    const { runDailyStatusSweep } = await import('@/lib/streetEasySync')
    await runDailyStatusSweep()
  } catch (e) {
    console.error('[sync/run] Status sweep error:', e)
  }

  return NextResponse.json({
    ok: !result.error,
    firstRun: isFirst,
    fetchedCount: result.fetched,
    newEmailCount: result.newEmails,
    newOpportunityCount: result.newOpps,
    skipped: result.skipped,
    error: result.error,
    readOnly: true,
    note: isFirst
      ? 'First sync — pulled last 90 days of inbox.'
      : 'Incremental sync — only fetched emails newer than your most recent stored email.',
  })
}

export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { runIncrementalSync } from '@/lib/backgroundSync'
import { prisma } from '@/lib/prisma'

// Internal route — only calls Microsoft Graph GET requests externally.
export async function POST() {
  const isFirst = (await prisma.rawEmail.count()) === 0

  // Capture sync start so we can identify opportunities created during this
  // sync (vs records the 5:30am cron has already covered). Small fudge
  // backwards to absorb clock skew between this process and the DB.
  const syncStartTime = new Date(Date.now() - 5_000)

  const result = await runIncrementalSync()

  // Scoped post-sync status check: only verify NEW opportunities created
  // during this sync that have a streetEasyId. The 5:30am cron handles
  // ongoing freshness of older records; this covers "the listing I just
  // pulled is current" without re-sweeping records the cron already saw.
  // Typical: 0-5 records. Non-fatal — sync result still returned on error.
  try {
    const { syncOpportunityStatus } = await import('@/lib/streetEasySync')
    const newOppsWithSE = await prisma.extractedOpportunity.findMany({
      where: {
        streetEasyId:        { not: null },
        streetEasyCheckedAt: null,
        createdAt:           { gte: syncStartTime },
      },
      select: { id: true },
      take: 20,            // safety rail — typical sync produces 0-5
    })
    for (const opp of newOppsWithSE) {
      try { await syncOpportunityStatus(opp.id) }
      catch (e) { console.error('[sync/run] status check', opp.id, e) }
    }
    if (newOppsWithSE.length > 0) {
      console.log(`[sync/run] post-sync status checks: ${newOppsWithSE.length}`)
    }
  } catch (e) {
    console.error('[sync/run] post-sync status check error:', e)
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

export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { runIncrementalSync } from '@/lib/backgroundSync'
import { prisma } from '@/lib/prisma'
import { isIngestionTestModeOnly } from '@/lib/config/ingestionTestMode'
import { checkCronBearer } from '@/lib/auth/cronBearer'

// Brief 9.0 — scheduler auth. The sync tick runs on an external scheduler in
// prod (Vercel Cron on Pro, or Upstash QStash on Hobby). Both hit this route
// via GET with `Authorization: Bearer <CRON_SECRET>`. Brief 41 (L1): the GET
// uses checkCronBearer (fails closed when the secret is unset; no ?secret=).
// The client-triggered POST (Check In on the home page) stays open — same-origin
// browser call; the app has no login by design.

// Internal route — only calls Microsoft Graph GET requests externally.
export async function POST() {
  return runSync()
}

// Scheduler entrypoint (Vercel Cron / QStash). Secured by CRON_SECRET.
export async function GET(req: NextRequest) {
  const auth = checkCronBearer(req.headers.get('authorization'), process.env.CRON_SECRET)
  if (auth !== 200) {
    return NextResponse.json({ error: auth === 500 ? 'CRON_SECRET not configured' : 'unauthorized' }, { status: auth })
  }
  return runSync()
}

async function runSync() {
  // Brief 6.0 — ingestion isolation gate. Blocks the production sync +
  // ingestion path so fixture validation can't trigger real Graph fetches or
  // pollute production tables. Escape hatch: INGESTION_TEST_MODE_ONLY=false.
  if (isIngestionTestModeOnly()) {
    return NextResponse.json(
      { ok: false, reason: 'INGESTION_TEST_MODE_ONLY is on', readOnly: true },
      { status: 423 },
    )
  }

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

  // Phase X.0 — current monthly RapidAPI usage so the UI can surface a
  // warning badge as the budget approaches the hard pause.
  const ym = new Date().toISOString().slice(0, 7)
  const quota = await prisma.rapidApiUsage.findUnique({ where: { yearMonth: ym } })
  const quotaStatus = quota ? {
    used:    quota.callsConsumed,
    budget:  quota.monthlyBudget,
    percent: Math.round((quota.callsConsumed / quota.monthlyBudget) * 100),
    paused:  !!quota.pausedAt,
  } : null

  // Brief 48 (4.5): the sync (Check In's POST and the scheduler's GET) no longer
  // runs the old matcher (lib/matchmaking.ts, deprecated since Brief 7.2) on
  // opportunities from the last 30 minutes [planner]. It wrote a homeowner's
  // full name and street address into Match.reason, which the CRM's morning
  // copy can show as a match's "Why" line; homeowner details stay out of
  // buyer-facing text [Ryan, 2026-10-19]. Opportunities this sync creates are
  // still matched by the 7.0 engine inside runIncrementalSync() (gated by
  // MATCHING_TEST_MODE_ONLY).

  // Phase 3B — Ingestion V2 (body + linked HTML). Behind feature flag so the
  // V1 pipeline keeps running by default. Non-blocking; failures are logged
  // but don't break the sync response.
  if (process.env.INGEST_V2 === 'true') {
    try {
      const v2Cutoff = new Date(Date.now() - 1000 * 60 * 30)
      const freshEmails = await prisma.rawEmail.findMany({
        where: {
          receivedDateTime: { gte: v2Cutoff },
          embeddedAt:       null,
        },
        select: { id: true },
        take: 50,
      })
      if (freshEmails.length > 0) {
        const { ingestEmailV2 } = await import('@/lib/ingestion/ingestEmailV2')
        void (async () => {
          for (const e of freshEmails) {
            try {
              const r = await ingestEmailV2(e.id)
              console.log(`[ingestV2] ${e.id}: ${r.chunksCreated} chunks (${JSON.stringify(r.byType)}) links: ${r.linksScraped}/${r.linksFound} scraped, ${r.linksFiltered} filtered, ${r.linksDeferred} deferred`)
            } catch (err) {
              console.error(`[ingestV2] ${e.id} failed:`, (err as Error).message)
            }
          }
        })().catch(err => console.error('[ingestV2] dispatch error:', err))
      }
    } catch (e) {
      console.error('[ingestV2] outer dispatch failed:', (e as Error).message)
    }
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
    quotaStatus,
    note: isFirst
      ? 'First sync — pulled last 90 days of inbox.'
      : 'Incremental sync — only fetched emails newer than your most recent stored email.',
  })
}

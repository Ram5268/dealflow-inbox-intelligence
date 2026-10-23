export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { isTestModeOnly } from '@/lib/config/testMode'
import { isMatchingTestModeOnly } from '@/lib/config/matchingTestMode'
import { isIngestionTestModeOnly } from '@/lib/config/ingestionTestMode'
import { readStatusWindow } from '@/lib/status/lastNight'
import {
  LAST_SYNC_ACTIONS, UNKNOWN_RECENT, UNKNOWN_RECENT_PUSH, deliveredCount,
  type Recent, type RecentPush,
} from '@/lib/status/olderSections'

// GET /api/debug/health — Brief 8.0-lite Fix #4. Instrumentation for post-deploy
// dogfooding: flag posture, Graph token freshness (read from the DB row — NEVER
// calls Graph), and last-24h activity per subsystem. No auth (localhost + solo
// prod). Every subsystem is best-effort so one failing query can't blank the page.
//
// Brief 47 (PR 4), Brief 46's DF-3: also the status window anyone can read, "what
// happened last night": lastNight, valuationSwitch, switches and rapidApi
// (lib/status/lastNight.ts: counts, times, booleans and reason codes only). Never
// cached. The retired Zapier ingest block (recentIngest) is gone.
//
// Brief 48 (PR 16, Revision 1): the older sections show counts and times only
// (lib/status/olderSections.ts). recentMatches, recentDismissals and recentPush used to
// list rows with match, party and listing ids, and the top-level orgId was the
// organization's id; they are gone [planner, Brief 48 Revision 1; engineering
// precaution: the page is public]. "Last sync" is the newest CRM copy or background
// sync only, no longer any action with "SYNC" in its name, and no longer the newest
// listing when neither has run [planner, Brief 48 Revision 1].

const DAY_MS = 24 * 60 * 60 * 1000
// Phone-notification rows read for the 7-day delivered count. About one digest a day,
// so the cap is never reached; if it were, the count would be a floor, never too high.
const PUSH_ROWS_CAP = 500

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn() } catch (e) {
    console.error(`[health] ${label} failed:`, (e as Error).message)
    return fallback
  }
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null
}

export async function GET() {
  const now = Date.now()
  const since24h = new Date(now - DAY_MS)
  const since7d = new Date(now - 7 * DAY_MS)

  // ── Flags ──────────────────────────────────────────────────────────────────
  const flags = {
    TEST_MODE_ONLY:          isTestModeOnly(),
    MATCHING_TEST_MODE_ONLY: isMatchingTestModeOnly(),
    INGESTION_TEST_MODE_ONLY: isIngestionTestModeOnly(),
  }

  // ── Graph token (read the ConnectedMailbox row; lastSyncAt stores expiry) ────
  const graphToken = await safe('graphToken', async () => {
    const rec = await prisma.connectedMailbox.findUnique({
      where: { id: 'runtime-token' },
      select: { lastSyncAt: true },
    })
    const expiresAt = rec?.lastSyncAt ?? null
    if (!expiresAt) return { expiresAt: null, expiresInMinutes: null, status: 'unknown' as const }
    const mins = Math.round((expiresAt.getTime() - now) / 60_000)
    const status =
      mins <= 0  ? 'expired' :
      mins <= 10 ? 'expiring-soon' :
                   'fresh'
    return { expiresAt: expiresAt.toISOString(), expiresInMinutes: mins, status }
  }, { expiresAt: null, expiresInMinutes: null, status: 'unknown' as const })

  // ── Last sync + 24h creation counts ──────────────────────────────────────────
  const lastSync = await safe('lastSync', async () => {
    const [syncLog, opportunitiesCreated, matchesCreated] = await Promise.all([
      prisma.auditLog.findFirst({
        where: { action: { in: [...LAST_SYNC_ACTIONS] } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      prisma.extractedOpportunity.count({ where: { createdAt: { gte: since24h } } }),
      prisma.match.count({ where: { createdAt: { gte: since24h } } }),
    ])
    return { at: iso(syncLog?.createdAt), opportunitiesCreated, matchesCreated }
  }, { at: null, opportunitiesCreated: 0, matchesCreated: 0 })

  // ── Recent activity per subsystem: the newest time and counts (Brief 48 PR 16) ──
  const recentMatches = await safe<Recent>('recentMatches', async () => {
    const [newest, last24h, last7d] = await Promise.all([
      prisma.match.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      prisma.match.count({ where: { createdAt: { gte: since24h } } }),
      prisma.match.count({ where: { createdAt: { gte: since7d } } }),
    ])
    return { newestAt: iso(newest?.createdAt), last24h, last7d }
  }, UNKNOWN_RECENT)

  const recentDismissals = await safe<Recent>('recentDismissals', async () => {
    const [newest, last24h, last7d] = await Promise.all([
      prisma.matchDismissal.findFirst({ orderBy: { dismissedAt: 'desc' }, select: { dismissedAt: true } }),
      prisma.matchDismissal.count({ where: { dismissedAt: { gte: since24h } } }),
      prisma.matchDismissal.count({ where: { dismissedAt: { gte: since7d } } }),
    ])
    return { newestAt: iso(newest?.dismissedAt), last24h, last7d }
  }, UNKNOWN_RECENT)

  const recentPush = await safe<RecentPush>('recentPush', async () => {
    const where = { action: 'PUSH_SENT' }
    const [newest, last24h, last7d, week] = await Promise.all([
      prisma.auditLog.findFirst({ where, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      prisma.auditLog.count({ where: { ...where, createdAt: { gte: since24h } } }),
      prisma.auditLog.count({ where: { ...where, createdAt: { gte: since7d } } }),
      prisma.auditLog.findMany({
        where: { ...where, createdAt: { gte: since7d } },
        orderBy: { createdAt: 'desc' }, take: PUSH_ROWS_CAP,
        select: { detailsJson: true },
      }),
    ])
    return { newestAt: iso(newest?.createdAt), last24h, last7d, last7dDelivered: deliveredCount(week) }
  }, UNKNOWN_RECENT_PUSH)

  const subsystemLastSuccess = await safe('subsystemLastSuccess', async () => {
    const [matcher, extraction] = await Promise.all([
      prisma.match.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      prisma.extractedOpportunity.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ])
    return {
      matcher:    iso(matcher?.createdAt),
      extraction: iso(extraction?.createdAt),
    }
  }, { matcher: null, extraction: null })

  // ── Last night, the switches and RapidAPI (Brief 47 PR 4) ─────────────────────
  const status = await readStatusWindow(prisma, safe)

  return NextResponse.json({
    flags,
    graphToken,
    lastSync,
    recentMatches,
    recentDismissals,
    recentPush,
    subsystemLastSuccess,
    ...status,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

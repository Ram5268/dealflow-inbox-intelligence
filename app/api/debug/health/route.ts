export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { isTestModeOnly } from '@/lib/config/testMode'
import { isMatchingTestModeOnly } from '@/lib/config/matchingTestMode'
import { isIngestionTestModeOnly } from '@/lib/config/ingestionTestMode'
import { readStatusWindow } from '@/lib/status/lastNight'

// GET /api/debug/health — Brief 8.0-lite Fix #4. Instrumentation for post-deploy
// dogfooding: flag posture, Graph token freshness (read from the DB row — NEVER
// calls Graph), and last-24h activity per subsystem. No auth (localhost + solo
// prod). Every subsystem is best-effort so one failing query can't blank the page.
//
// Brief 47 (PR 4), Brief 46's DF-3: also the status window anyone can read, "what
// happened last night": lastNight, valuationSwitch, switches and rapidApi
// (lib/status/lastNight.ts: counts, times, booleans and reason codes only). Never
// cached. The retired Zapier ingest block (recentIngest) is gone.

const DAY_MS = 24 * 60 * 60 * 1000

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
  const orgId = await safe('orgId', () => getCurrentOrgId(), '')

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
    const syncLog = await prisma.auditLog.findFirst({
      where: { action: { contains: 'SYNC' } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    let at = syncLog?.createdAt ?? null
    if (!at) {
      const newestOpp = await prisma.extractedOpportunity.findFirst({
        orderBy: { createdAt: 'desc' }, select: { createdAt: true },
      })
      at = newestOpp?.createdAt ?? null
    }
    const [opportunitiesCreated, matchesCreated] = await Promise.all([
      prisma.extractedOpportunity.count({ where: { createdAt: { gte: since24h } } }),
      prisma.match.count({ where: { createdAt: { gte: since24h } } }),
    ])
    return { at: iso(at), opportunitiesCreated, matchesCreated }
  }, { at: null, opportunitiesCreated: 0, matchesCreated: 0 })

  // ── Recent rows per subsystem ─────────────────────────────────────────────────
  const recentMatches = await safe('recentMatches', async () => {
    const rows = await prisma.match.findMany({
      orderBy: { createdAt: 'desc' }, take: 10,
      select: { id: true, score: true, tier: true, counterpartType: true, createdAt: true },
    })
    return rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() }))
  }, [] as Array<Record<string, unknown>>)

  const recentDismissals = await safe('recentDismissals', async () => {
    const rows = await prisma.matchDismissal.findMany({
      orderBy: { dismissedAt: 'desc' }, take: 10,
      select: { partyId: true, listingId: true, dismissalReason: true, dismissedAt: true },
    })
    return rows.map(r => ({
      partyId: r.partyId, listingId: r.listingId,
      reason: r.dismissalReason, createdAt: r.dismissedAt.toISOString(),
    }))
  }, [] as Array<Record<string, unknown>>)

  const recentPush = await safe('recentPush', async () => {
    const rows = await prisma.auditLog.findMany({
      where: { action: 'PUSH_SENT' },
      orderBy: { createdAt: 'desc' }, take: 10,
      select: { detailsJson: true, createdAt: true },
    })
    return rows.map(r => {
      const d = (r.detailsJson ?? {}) as Record<string, unknown>
      const delivered = typeof d.delivered === 'number' ? d.delivered : null
      return {
        title: String(d.kind ?? 'push'),
        body: d.matchId ? `match ${d.matchId}` : d.matchCount != null ? `${d.matchCount} matches` : '',
        deliveredAt: typeof d.at === 'string' ? d.at : r.createdAt.toISOString(),
        success: delivered != null ? delivered > 0 : null,
      }
    })
  }, [] as Array<Record<string, unknown>>)

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
    orgId: orgId || null,
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

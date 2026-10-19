import { prisma } from '@/lib/prisma'
import { sendPushToOrg } from '@/lib/push/send'
import { hotAlertText } from '@/lib/push/digestText'

// Brief 7.4 (A.2) — realtime push the moment a HOT match lands.
//
// The Brief 7.0 tiering engine is still test-mode-only, so no production path
// writes MatchTier='HOT' yet. On the LIVE matcher (lib/matchmaking.ts via
// backgroundSync) "hot" maps to score >= 90 — the same GOLD band the /matches UI
// uses. Callers pass an already-selected top match; this module owns the prefs
// check, the 5-per-hour rate limit, the send, and the audit row.
//
// Overflow past the hourly cap is dropped from realtime and rolls into the next
// morning digest (which re-queries top matches from scratch).
//
// Brief 48 (PR 5): the text is a count, never a buyer's or homeowner's name or an
// address [planner, Brief 48 §3 PR 5], so callers pass only the organization and the
// match. The match id is only in the link. It fires only from the email intake,
// which is paused [Ryan, 2026-09-24].

const REALTIME_CAP_PER_HOUR = 5

export interface HotAlertInput {
  organizationId: string
  matchId: string
}

async function realtimeEnabled(organizationId: string): Promise<boolean> {
  const prefs = await prisma.notificationPreferences.findUnique({
    where: { organizationId },
    select: { realtimeEnabled: true },
  })
  // Default-on when no prefs row exists yet.
  return prefs?.realtimeEnabled ?? true
}

async function sentInLastHour(organizationId: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000)
  return prisma.auditLog.count({
    where: {
      organizationId,
      action: 'PUSH_SENT',
      createdAt: { gte: since },
      // Only realtime pushes count against the realtime cap.
      detailsJson: { path: ['kind'], equals: 'realtime' },
    },
  })
}

// Fire a realtime HOT alert if enabled and under the hourly cap. Returns whether
// a push was sent. Never throws — push is best-effort and must not break sync.
export async function maybeFireHotAlert(input: HotAlertInput): Promise<boolean> {
  try {
    if (!(await realtimeEnabled(input.organizationId))) return false
    if ((await sentInLastHour(input.organizationId)) >= REALTIME_CAP_PER_HOUR) {
      console.warn(`[hotAlert] realtime cap (${REALTIME_CAP_PER_HOUR}/hr) reached for ${input.organizationId} — deferring to digest`)
      return false
    }

    const delivered = await sendPushToOrg(input.organizationId, {
      ...hotAlertText(),
      url: `/matches?m=${input.matchId}`,
    })

    await prisma.auditLog.create({
      data: {
        organizationId: input.organizationId,
        action: 'PUSH_SENT',
        detailsJson: { kind: 'realtime', matchId: input.matchId, delivered, at: new Date().toISOString() },
      },
    }).catch(() => {})

    return delivered > 0
  } catch (e) {
    console.error('[hotAlert] failed:', (e as Error).message)
    return false
  }
}

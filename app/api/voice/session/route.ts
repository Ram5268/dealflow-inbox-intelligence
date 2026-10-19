export const dynamic = 'force-dynamic'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { handleVoiceSession, VOICE_SESSION_ACTION } from '@/lib/voice/session'
import { clientAddress, hashAddress, limit, recordRefusal, startOfNewYorkDay } from '@/lib/spendGuard'

export const maxDuration = 15

// Brief 36 — WebRTC handshake for voice mode's live transcription. Logic and
// guards (flag gate, SDP-only, 20 KB cap, 60 sessions per rolling hour counted
// from AuditLog) live in lib/voice/session.ts.
// Brief 43 PR 17 [engineering precaution]: no login [Ryan, 2026-09-24], so
// also 10 an hour per address (VOICE_SESSIONS_PER_IP_PER_HOUR) and 100 a day
// in all (VOICE_SESSIONS_DAILY_CAP), counted from the same VOICE_SESSION rows.
// Each row is written before the counts and now carries the address's salted
// hash (never the address); a refused request's row becomes its counts-only
// SPEND_GUARD_REFUSED row.
const notMine = (exceptId?: string) => (exceptId ? { id: { not: exceptId } } : {})

export async function POST(req: Request) {
  const ipHash = hashAddress(clientAddress(req.headers))
  return handleVoiceSession(req, {
    enabled: process.env.NEXT_PUBLIC_VOICE_ENABLED === 'true',
    apiKey: process.env.OPENAI_API_KEY,
    countSessionsSince: (since, exceptId) =>
      prisma.auditLog.count({ where: { action: VOICE_SESSION_ACTION, createdAt: { gte: since }, ...notMine(exceptId) } }),
    countAddressSessionsSince: (since, exceptId) =>
      prisma.auditLog.count({
        where: {
          action: VOICE_SESSION_ACTION, createdAt: { gte: since }, ...notMine(exceptId),
          detailsJson: { path: ['ipHash'], equals: ipHash },
        },
      }),
    sessionsPerAddressPerHour: limit('VOICE_SESSIONS_PER_IP_PER_HOUR'),
    dayStart: startOfNewYorkDay(),
    sessionsPerDay: limit('VOICE_SESSIONS_DAILY_CAP'),
    refuseSession: (id, reason) => recordRefusal('voice_session', reason, id),
    logSession: async () =>
      (await prisma.auditLog.create({
        data: { action: VOICE_SESSION_ACTION, organizationId: await getCurrentOrgId(), detailsJson: { ipHash } },
        select: { id: true },
      })).id,
  })
}

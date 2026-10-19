export const dynamic = 'force-dynamic'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { handleVoiceSession, VOICE_SESSION_ACTION } from '@/lib/voice/session'
import { clientAddress, hashAddress, limit, logSpendRefusal } from '@/lib/spendGuard'

export const maxDuration = 15

// Brief 36 — WebRTC handshake for voice mode's live transcription. Logic and
// guards (flag gate, SDP-only, 20 KB cap, 60 sessions per rolling hour counted
// from AuditLog) live in lib/voice/session.ts.
// Brief 43 PR 17 [engineering precaution]: plus 10 an hour per address
// (VOICE_SESSIONS_PER_IP_PER_HOUR), counted from the same VOICE_SESSION rows,
// which now carry the address's salted hash (never the address), so it costs
// no extra write. No login [Ryan, 2026-09-24].
export async function POST(req: Request) {
  const ipHash = hashAddress(clientAddress(req.headers))
  return handleVoiceSession(req, {
    enabled: process.env.NEXT_PUBLIC_VOICE_ENABLED === 'true',
    apiKey: process.env.OPENAI_API_KEY,
    countSessionsSince: since =>
      prisma.auditLog.count({ where: { action: VOICE_SESSION_ACTION, createdAt: { gte: since } } }),
    countAddressSessionsSince: since =>
      prisma.auditLog.count({
        where: { action: VOICE_SESSION_ACTION, createdAt: { gte: since }, detailsJson: { path: ['ipHash'], equals: ipHash } },
      }),
    sessionsPerAddressPerHour: limit('VOICE_SESSIONS_PER_IP_PER_HOUR'),
    logRefusal: reason => logSpendRefusal('voice_session', reason),
    logSession: async () =>
      prisma.auditLog.create({ data: { action: VOICE_SESSION_ACTION, organizationId: await getCurrentOrgId(), detailsJson: { ipHash } } }),
  })
}

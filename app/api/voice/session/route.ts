export const dynamic = 'force-dynamic'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { handleVoiceSession, VOICE_SESSION_ACTION } from '@/lib/voice/session'

export const maxDuration = 15

// Brief 36 — WebRTC handshake for voice mode's live transcription. Logic and
// guards (flag gate, SDP-only, 20 KB cap, 60 sessions per rolling hour counted
// from AuditLog) live in lib/voice/session.ts.
export async function POST(req: Request) {
  return handleVoiceSession(req, {
    enabled: process.env.NEXT_PUBLIC_VOICE_ENABLED === 'true',
    apiKey: process.env.OPENAI_API_KEY,
    countSessionsSince: since =>
      prisma.auditLog.count({ where: { action: VOICE_SESSION_ACTION, createdAt: { gte: since } } }),
    logSession: async () =>
      prisma.auditLog.create({ data: { action: VOICE_SESSION_ACTION, organizationId: await getCurrentOrgId() } }),
  })
}

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// Stores a temporary token in the DB so you don't need to restart the server.
// Token never goes to the frontend — only stored server-side.
export async function POST(req: NextRequest) {
  const body = await req.json()
  const token: string = body.token ?? ''

  if (!token || token.length < 100) {
    return NextResponse.json({ ok: false, error: 'Invalid token — paste the full token from Graph Explorer.' }, { status: 400 })
  }

  // Store in AuditLog-adjacent settings via a dedicated mailbox record
  await prisma.connectedMailbox.upsert({
    where: { id: 'runtime-token' },
    create: {
      id: 'runtime-token',
      email: 'runtime',
      provider: 'microsoft',
      accessTokenEncrypted: token,
      readOnlyMode: true,
    },
    update: {
      accessTokenEncrypted: token,
      updatedAt: new Date(),
    },
  })

  await prisma.auditLog.create({
    data: {
      action: 'TOKEN_UPDATED',
      detailsJson: { source: 'settings_ui', timestamp: new Date().toISOString() },
    },
  })

  return NextResponse.json({ ok: true, message: 'Token saved. Test your connection now.' })
}

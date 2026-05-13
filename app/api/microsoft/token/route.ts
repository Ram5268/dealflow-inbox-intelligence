import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// CORS — allows the bookmarklet (running on developer.microsoft.com) to POST here
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const token: string = body.token ?? ''

  if (!token || token.length < 100) {
    return NextResponse.json(
      { ok: false, error: 'Invalid token.' },
      { status: 400, headers: CORS }
    )
  }

  // Decode expiry from the JWT payload (exp claim) so we know when it lapses
  let expiresAt: Date | null = null
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
    if (payload.exp) expiresAt = new Date(payload.exp * 1000)
  } catch { /* non-fatal */ }

  await prisma.connectedMailbox.upsert({
    where: { id: 'runtime-token' },
    create: {
      id: 'runtime-token',
      email: 'runtime',
      provider: 'microsoft',
      accessTokenEncrypted: token,
      lastSyncAt: expiresAt,
      readOnlyMode: true,
    },
    update: {
      accessTokenEncrypted: token,
      lastSyncAt: expiresAt,
      updatedAt: new Date(),
    },
  })

  await prisma.auditLog.create({
    data: {
      action: 'TOKEN_UPDATED',
      detailsJson: { source: body.source ?? 'settings_ui', timestamp: new Date().toISOString(), expiresAt: expiresAt?.toISOString() },
    },
  })

  return NextResponse.json(
    { ok: true, message: 'Token saved.', expiresAt: expiresAt?.toISOString() ?? null },
    { headers: CORS }
  )
}

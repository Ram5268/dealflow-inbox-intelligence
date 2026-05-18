export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

// Polls Microsoft's token endpoint for a device code grant.
// Returns ok:true when the user has signed in and tokens are stored.
export async function POST(req: NextRequest) {
  const { deviceCode } = await req.json()
  const clientId     = process.env.AZURE_CLIENT_ID
  const clientSecret = process.env.AZURE_CLIENT_SECRET
  const tenant       = process.env.AZURE_TENANT ?? 'common'

  if (!clientId) {
    return NextResponse.json({ error: 'AZURE_CLIENT_ID not configured' }, { status: 503 })
  }

  const body: Record<string, string> = {
    client_id:   clientId,
    grant_type:  'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
  }
  if (clientSecret) body.client_secret = clientSecret

  try {
    const res = await fetch(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
      }
    )

    const data = await res.json()

    // Still waiting for user to sign in
    if (data.error === 'authorization_pending') {
      return NextResponse.json({ ok: false, pending: true })
    }

    // Code expired
    if (data.error === 'expired_token' || data.error === 'code_expired') {
      return NextResponse.json({ ok: false, error: 'expired' })
    }

    if (!data.access_token) {
      return NextResponse.json({ ok: false, error: data.error_description ?? 'unknown' })
    }

    // Decode expiry
    let expiresAt: Date | null = null
    try {
      const payload = JSON.parse(Buffer.from(data.access_token.split('.')[1], 'base64').toString())
      if (payload.exp) expiresAt = new Date(payload.exp * 1000)
    } catch { /* non-fatal */ }

    // Store both tokens
    await prisma.connectedMailbox.upsert({
      where: { id: 'runtime-token' },
      create: {
        id: 'runtime-token',
        email: data.id_token
          ? JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64').toString()).preferred_username ?? 'runtime'
          : 'runtime',
        provider: 'microsoft',
        accessTokenEncrypted:  data.access_token,
        refreshTokenEncrypted: data.refresh_token ?? null,
        lastSyncAt: expiresAt,
        readOnlyMode: true,
      },
      update: {
        accessTokenEncrypted:  data.access_token,
        refreshTokenEncrypted: data.refresh_token ?? undefined,
        lastSyncAt: expiresAt,
        updatedAt:  new Date(),
      },
    })

    await prisma.auditLog.create({
      data: {
        action: 'TOKEN_UPDATED',
        detailsJson: { source: 'device_code_flow', expiresAt: expiresAt?.toISOString(), hasRefreshToken: !!data.refresh_token },
      },
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}

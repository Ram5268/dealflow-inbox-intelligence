export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getCurrentOrgId } from '@/lib/auth/orgContext'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const error = req.nextUrl.searchParams.get('error')
  const errorDescription = req.nextUrl.searchParams.get('error_description')

  if (error) {
    const msg = encodeURIComponent(errorDescription ?? error)
    return NextResponse.redirect(
      new URL(`/settings?oauth_error=${msg}`, req.url)
    )
  }

  if (!code) {
    return NextResponse.redirect(
      new URL('/settings?oauth_error=No+authorization+code+returned', req.url)
    )
  }

  const clientId = process.env.AZURE_CLIENT_ID!
  const clientSecret = process.env.AZURE_CLIENT_SECRET!
  const redirectUri = process.env.AZURE_REDIRECT_URI!
  const tenant = process.env.AZURE_TENANT ?? 'common'

  // Exchange code for tokens
  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read offline_access',
      }),
    }
  )

  if (!tokenRes.ok) {
    const body = await tokenRes.text()
    const msg = encodeURIComponent(`Token exchange failed: ${body}`)
    return NextResponse.redirect(new URL(`/settings?oauth_error=${msg}`, req.url))
  }

  const tokens = await tokenRes.json()
  const { access_token, refresh_token, expires_in } = tokens

  const expiresAt = new Date(Date.now() + expires_in * 1000)

  const organizationId = await getCurrentOrgId()

  // Store tokens in DB against the runtime-token mailbox record
  await prisma.connectedMailbox.upsert({
    where: { id: 'runtime-token' },
    create: {
      organizationId,
      id: 'runtime-token',
      email: 'oauth',
      provider: 'microsoft',
      accessTokenEncrypted: access_token,
      refreshTokenEncrypted: refresh_token ?? null,
      lastSyncAt: expiresAt,
      readOnlyMode: true,
    },
    update: {
      accessTokenEncrypted: access_token,
      refreshTokenEncrypted: refresh_token ?? null,
      lastSyncAt: expiresAt,
      updatedAt: new Date(),
    },
  })

  await prisma.auditLog.create({
    data: {
      organizationId,
      action: 'OAUTH_CONNECTED',
      detailsJson: { timestamp: new Date().toISOString(), expiresAt: expiresAt.toISOString() },
    },
  })

  return NextResponse.redirect(new URL('/settings?oauth_success=1', req.url))
}

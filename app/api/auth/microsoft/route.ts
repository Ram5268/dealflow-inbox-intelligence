export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { graphEnabled, GRAPH_PAUSED_MESSAGE } from '@/lib/graphAccess'

const SCOPES = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/User.Read',
  'https://graph.microsoft.com/Calendars.ReadWrite',
  'offline_access',
  'openid',
  'profile',
].join(' ')

export async function GET(req: Request) {
  // Outlook is paused (Brief 41): back to Settings, which explains why.
  if (!graphEnabled()) {
    return NextResponse.redirect(new URL(`/settings?oauth_error=${encodeURIComponent(GRAPH_PAUSED_MESSAGE)}`, req.url))
  }
  const clientId = process.env.AZURE_CLIENT_ID
  const redirectUri = process.env.AZURE_REDIRECT_URI
  const tenant = process.env.AZURE_TENANT ?? 'common'

  if (!clientId || !redirectUri) {
    return NextResponse.json(
      { error: 'AZURE_CLIENT_ID or AZURE_REDIRECT_URI not set in .env' },
      { status: 500 }
    )
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    response_mode: 'query',
    prompt: 'select_account',
  })

  const authUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}`
  return NextResponse.redirect(authUrl)
}

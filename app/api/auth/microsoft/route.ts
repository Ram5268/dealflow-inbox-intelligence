import { NextResponse } from 'next/server'

const SCOPES = [
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
  'openid',
  'profile',
].join(' ')

export async function GET() {
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

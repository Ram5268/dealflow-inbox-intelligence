export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'

// Initiates the OAuth 2.0 device code flow.
// User visits verificationUri, enters userCode, signs in with their DE account.
// No IT consent required — uses delegated permissions the user approves themselves.
export async function POST() {
  const clientId = process.env.AZURE_CLIENT_ID
  if (!clientId) {
    return NextResponse.json(
      { error: 'AZURE_CLIENT_ID not configured. Add it in Railway environment variables.' },
      { status: 503 }
    )
  }

  const tenant = process.env.AZURE_TENANT ?? 'common'
  const scope  = 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.ReadWrite offline_access'

  try {
    const res = await fetch(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, scope }),
      }
    )

    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ error: err }, { status: 400 })
    }

    const data = await res.json()
    return NextResponse.json({
      userCode:        data.user_code,
      verificationUri: data.verification_uri,
      deviceCode:      data.device_code,
      expiresIn:       data.expires_in,
      message:         data.message,
    })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}

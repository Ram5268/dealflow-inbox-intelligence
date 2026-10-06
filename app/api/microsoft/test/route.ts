export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { testConnection } from '@/lib/microsoftGraph'
import { graphEnabled, GRAPH_PAUSED_BODY } from '@/lib/graphAccess'

// READ-ONLY: Only calls GET /me on Microsoft Graph
export async function GET() {
  if (!graphEnabled()) return NextResponse.json(GRAPH_PAUSED_BODY, { status: 403 })
  const result = await testConnection()

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.error,
        hint: 'Get a fresh token from https://developer.microsoft.com/en-us/graph/graph-explorer',
      },
      { status: result.error?.includes('not set') ? 400 : 401 }
    )
  }

  // Never expose the raw token — return only safe user info
  return NextResponse.json({
    ok: true,
    displayName: result.displayName,
    mail: result.mail,
    userPrincipalName: result.userPrincipalName,
    id: result.id,
    readOnly: true,
    note: 'Read-only connection. No write permissions used.',
  })
}

export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { graphEnabled } from '@/lib/graphAccess'

// Decodes the stored Graph JWT to extract the user's given name.
// We only read the payload — no signature verification needed for display purposes.
// Falls back through: given_name → first word of displayName → null.
export async function GET() {
  // Outlook is paused (Brief 41): no Microsoft token is read, even from env.
  if (!graphEnabled()) return NextResponse.json({ givenName: null })
  const token = process.env.MICROSOFT_GRAPH_ACCESS_TOKEN
  if (!token) return NextResponse.json({ givenName: null })

  try {
    const parts = token.split('.')
    if (parts.length !== 3) return NextResponse.json({ givenName: null })

    // Base64url decode — pad to multiple of 4
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'))

    const givenName: string | null =
      payload.given_name?.trim() ||
      (typeof payload.name === 'string' ? payload.name.split(/[\s,]+/).find((p: string) => /^[A-Z]/.test(p)) ?? null : null) ||
      null

    return NextResponse.json({ givenName })
  } catch {
    return NextResponse.json({ givenName: null })
  }
}

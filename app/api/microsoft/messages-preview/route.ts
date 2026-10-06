export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getRecentMessages } from '@/lib/microsoftGraph'
import { graphEnabled, GRAPH_PAUSED_BODY } from '@/lib/graphAccess'

// READ-ONLY: Only calls GET /me/messages. Does not store anything.
export async function GET() {
  if (!graphEnabled()) return NextResponse.json(GRAPH_PAUSED_BODY, { status: 403 })
  try {
    const messages = await getRecentMessages(5, 30)

    // Strip anything sensitive — never expose full body content or token
    const preview = messages.map((m) => ({
      id: m.id,
      subject: m.subject,
      from: {
        name: m.from?.emailAddress?.name,
        email: m.from?.emailAddress?.address,
      },
      receivedDateTime: m.receivedDateTime,
      bodyPreview: m.bodyPreview,
      webLink: m.webLink,
    }))

    return NextResponse.json({
      ok: true,
      count: preview.length,
      messages: preview,
      readOnly: true,
      note: 'Read-only preview. Nothing stored.',
    })
  } catch (err) {
    const message = (err as Error).message
    return NextResponse.json(
      { ok: false, error: message },
      { status: message.includes('not set') ? 400 : 401 }
    )
  }
}

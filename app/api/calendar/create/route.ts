export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { createCalendarEvent } from '@/lib/microsoftCalendar'

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const subject  = String(body.subject  ?? '').trim()
  const startISO = String(body.startISO ?? '').trim()
  const endISO   = String(body.endISO   ?? '').trim()
  const location = body.location ? String(body.location).trim() : undefined
  const notes    = body.notes    ? String(body.notes).trim()    : undefined

  if (!subject)  return NextResponse.json({ error: 'subject is required' },  { status: 400 })
  if (!startISO) return NextResponse.json({ error: 'startISO is required' }, { status: 400 })

  // Default end time: 30 minutes after start if not provided
  const resolvedEnd = endISO || (() => {
    const d = new Date(startISO)
    d.setMinutes(d.getMinutes() + 30)
    return d.toISOString()
  })()

  try {
    const created = await createCalendarEvent({ subject, startISO, endISO: resolvedEnd, location, notes })
    return NextResponse.json({ ok: true, eventId: created.id, webLink: created.webLink })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

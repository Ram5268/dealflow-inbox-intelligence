export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'
import { getTodayEvents } from '@/lib/microsoftCalendar'
import { graphEnabled } from '@/lib/graphAccess'

export async function GET() {
  // Outlook is paused (Brief 41): an empty day, and the home card says why.
  if (!graphEnabled()) {
    return NextResponse.json({ todayCount: 0, nextEvent: null, events: [], paused: true })
  }
  const events = await getTodayEvents()
  const now = new Date()
  const upcoming = events.filter(e => new Date(e.start) >= now)
  const nextEvent = upcoming[0] ?? null

  return NextResponse.json({
    todayCount: events.length,
    nextEvent: nextEvent ? {
      subject: nextEvent.subject,
      start: nextEvent.start,
      location: nextEvent.location,
    } : null,
    events,
  })
}

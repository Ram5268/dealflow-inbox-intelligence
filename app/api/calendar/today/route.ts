import { NextResponse } from 'next/server'
import { getTodayEvents } from '@/lib/microsoftCalendar'

export async function GET() {
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

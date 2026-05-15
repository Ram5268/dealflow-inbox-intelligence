import { getToken } from './microsoftGraph'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

export interface CalendarEvent {
  id: string
  subject: string
  start: string        // ISO datetime string
  end: string
  location: string | null
  bodyPreview: string | null
  attendeeCount: number
  webLink: string | null
}

interface GraphEventResponse {
  value: Array<{
    id: string
    subject: string
    webLink?: string
    bodyPreview?: string
    start: { dateTime: string; timeZone: string }
    end: { dateTime: string; timeZone: string }
    location?: { displayName?: string }
    attendees?: Array<{ emailAddress: { name: string; address: string } }>
  }>
}

function parseEvent(raw: GraphEventResponse['value'][0]): CalendarEvent {
  return {
    id: raw.id,
    subject: raw.subject ?? '(No title)',
    start: raw.start.dateTime,
    end: raw.end.dateTime,
    location: raw.location?.displayName ?? null,
    bodyPreview: raw.bodyPreview ?? null,
    attendeeCount: raw.attendees?.length ?? 0,
    webLink: raw.webLink ?? null,
  }
}

export async function getCalendarEvents(daysAhead: number): Promise<CalendarEvent[]> {
  try {
    const token = await getToken()
    const now = new Date()
    const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000)

    const params = new URLSearchParams({
      startDateTime: now.toISOString(),
      endDateTime: future.toISOString(),
      '$select': 'id,subject,start,end,location,bodyPreview,attendees,webLink',
      '$top': '25',
      '$orderby': 'start/dateTime',
    })

    const res = await fetch(`${GRAPH_BASE}/me/calendarView?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) return []
    const data: GraphEventResponse = await res.json()
    return (data.value ?? []).map(parseEvent)
  } catch {
    return []
  }
}

export async function getTodayEvents(): Promise<CalendarEvent[]> {
  try {
    const token = await getToken()

    // Midnight to end-of-day in local time
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const end = new Date()
    end.setHours(23, 59, 59, 999)

    const params = new URLSearchParams({
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      '$select': 'id,subject,start,end,location,bodyPreview,attendees,webLink',
      '$top': '20',
      '$orderby': 'start/dateTime',
    })

    const res = await fetch(`${GRAPH_BASE}/me/calendarView?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) return []
    const data: GraphEventResponse = await res.json()
    return (data.value ?? []).map(parseEvent)
  } catch {
    return []
  }
}

export interface CreateEventInput {
  subject: string
  startISO: string
  endISO: string
  location?: string
  notes?: string
}

export interface CreatedEvent {
  id: string
  webLink: string | null
}

export async function createCalendarEvent(input: CreateEventInput): Promise<CreatedEvent> {
  const token = await getToken()

  const body = {
    subject: input.subject,
    start: { dateTime: input.startISO, timeZone: 'America/New_York' },
    end:   { dateTime: input.endISO,   timeZone: 'America/New_York' },
    ...(input.location ? { location: { displayName: input.location } } : {}),
    ...(input.notes ? { body: { contentType: 'text', content: input.notes } } : {}),
  }

  const res = await fetch(`${GRAPH_BASE}/me/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Calendar create failed (${res.status}): ${err}`)
  }

  const created = await res.json()
  return { id: created.id, webLink: created.webLink ?? null }
}

export function formatEventsForAI(events: CalendarEvent[]): string {
  if (events.length === 0) return ''
  const lines = events.map(e => {
    const dt = new Date(e.start)
    const day = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()
    const time = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
    const loc = e.location ? ` — ${e.location}` : ''
    return `[${day} · ${time}] ${e.subject}${loc}`
  })
  return `\n\nCALENDAR — UPCOMING SCHEDULE:\n${lines.join('\n')}`
}

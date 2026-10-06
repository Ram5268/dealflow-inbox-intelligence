import type { ContextFetcher } from './types'
import { getCalendarEvents, formatEventsForAI } from '@/lib/microsoftCalendar'
import { graphEnabled } from '@/lib/graphAccess'

// Triggered by parsed.isCalendar OR the user is replying with a confirm to a pending event.
// (The confirm fast-path that actually CREATES the event stays inline in route.ts;
// this fetcher only provides 7-day calendar context to the LLM.)
export const calendarFetcher: ContextFetcher = async ({ parsed, isConfirmMessage }) => {
  if (!parsed.isCalendar && !isConfirmMessage) return { block: null }
  // Outlook is paused (Brief 41): say so, so Drift doesn't guess or offer to book.
  if (!graphEnabled()) {
    return {
      block: "CALENDAR: Outlook is paused, so you can't see or add calendar events right now. If asked, say that plainly and don't offer to book anything.",
    }
  }

  try {
    const events = await getCalendarEvents(7)
    const formatted = formatEventsForAI(events)
    return { block: formatted && formatted.length > 0 ? formatted : null }
  } catch {
    return { block: null }
  }
}

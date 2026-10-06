import type { ContextFetcher } from './types'
import { getCalendarEvents, formatEventsForAI } from '@/lib/microsoftCalendar'
import { graphEnabled, GRAPH_PAUSED_CALENDAR_BLOCK } from '@/lib/graphAccess'

// Triggered by parsed.isCalendar OR the user is replying with a confirm to a pending event.
// (The confirm fast-path that actually CREATES the event stays inline in route.ts;
// this fetcher only provides 7-day calendar context to the LLM.)
export const calendarFetcher: ContextFetcher = async ({ parsed, isConfirmMessage }) => {
  // Outlook is paused (Brief 41): on every turn, so Drift never guesses a
  // calendar or offers to book (its prompt otherwise asks for pendingEvent).
  if (!graphEnabled()) return { block: GRAPH_PAUSED_CALENDAR_BLOCK }
  if (!parsed.isCalendar && !isConfirmMessage) return { block: null }

  try {
    const events = await getCalendarEvents(7)
    const formatted = formatEventsForAI(events)
    return { block: formatted && formatted.length > 0 ? formatted : null }
  } catch {
    return { block: null }
  }
}

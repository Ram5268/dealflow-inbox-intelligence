import type { ContextFetcher } from './types'
import { getCalendarEvents, formatEventsForAI } from '@/lib/microsoftCalendar'

// Triggered by parsed.isCalendar OR the user is replying with a confirm to a pending event.
// (The confirm fast-path that actually CREATES the event stays inline in route.ts;
// this fetcher only provides 7-day calendar context to the LLM.)
export const calendarFetcher: ContextFetcher = async ({ parsed, isConfirmMessage }) => {
  if (!parsed.isCalendar && !isConfirmMessage) return { block: null }

  try {
    const events = await getCalendarEvents(7)
    const formatted = formatEventsForAI(events)
    return { block: formatted && formatted.length > 0 ? formatted : null }
  } catch {
    return { block: null }
  }
}

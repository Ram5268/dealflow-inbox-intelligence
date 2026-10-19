import type { ContextFetcher } from './types'
import { getCalendarEvents, formatEventsForAI } from '@/lib/microsoftCalendar'
import { graphEnabled, GRAPH_PAUSED_CALENDAR_BLOCK, GRAPH_ON_CALENDAR_NOTE, graphPausedEmailBlock } from '@/lib/graphAccess'
import { prisma } from '@/lib/prisma'
import { todayLine } from './today'

// Triggered by parsed.isCalendar OR the user is replying with a confirm to a pending event.
// (The confirm fast-path that actually CREATES the event stays inline in route.ts;
// this fetcher only provides 7-day calendar context to the LLM.)
// Brief 43 PR 14: every turn also starts with today's date in New York.
export const calendarFetcher: ContextFetcher = async ({ parsed, isConfirmMessage }) => {
  // Outlook is paused (Brief 41): on every turn, so Drift never guesses a
  // calendar or offers to book. Brief 43 PR 14: plus the D8 wording, and that
  // email reading is paused, with the newest email's date (Q29).
  if (!graphEnabled()) return { block: todayLine(new Date()) + GRAPH_PAUSED_CALENDAR_BLOCK + graphPausedEmailBlock(await newestEmailAt()) }
  // Brief 43 PR 14 (Q33): the proposal lines only while Outlook is on.
  const head = todayLine(new Date()) + GRAPH_ON_CALENDAR_NOTE
  if (!parsed.isCalendar && !isConfirmMessage) return { block: head }

  try {
    const events = await getCalendarEvents(7)
    const formatted = formatEventsForAI(events)
    return { block: formatted && formatted.length > 0 ? head + formatted : head }
  } catch {
    return { block: head }
  }
}

// The newest email DealFlow read before the pause (the same column the email
// sync resumes from, lib/backgroundSync.ts). A failed read just leaves the date out.
async function newestEmailAt(): Promise<Date | null> {
  try {
    const row = await prisma.rawEmail.findFirst({ orderBy: { receivedDateTime: 'desc' }, select: { receivedDateTime: true } })
    return row?.receivedDateTime ?? null
  } catch {
    return null
  }
}

import type { ContextFetcher } from './types'
import { getCalendarEvents, formatEventsForAI } from '@/lib/microsoftCalendar'
import { graphEnabled, GRAPH_PAUSED_CALENDAR_BLOCK, GRAPH_ON_CALENDAR_NOTE, graphPausedEmailBlock } from '@/lib/graphAccess'
import { prisma } from '@/lib/prisma'
import { withTimeout, isTimedOut } from '@/lib/chat/turnBudget'
import { todayLine } from './today'

// Review r1: the newest-email read gets this long. The fixed lines (today, the
// calendar note) are built first, so a slow read only leaves out the date; it
// can't run into the whole lookup's timeout (composeContext) and lose them all.
export const NEWEST_EMAIL_READ_MS = 1_500

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
// sync resumes from, lib/backgroundSync.ts). A failed or slow read just leaves
// the date out.
async function newestEmailAt(): Promise<Date | null> {
  try {
    const read = prisma.rawEmail
      .findFirst({ orderBy: { receivedDateTime: 'desc' }, select: { receivedDateTime: true } })
      .then(row => row?.receivedDateTime ?? null)
    read.catch(() => {}) // a late failure after the timeout is not an unhandled rejection
    const result = await withTimeout(read, NEWEST_EMAIL_READ_MS, 'newest email')
    return isTimedOut(result) ? null : result
  } catch {
    return null
  }
}

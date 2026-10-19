// Brief 48 (PR 4): New York time that comes out the same on the server (Vercel runs in UTC) and on a
// phone in any time zone [planner]. Built on Intl.DateTimeFormat with timeZone 'America/New_York', so
// no new dependency, and never on the computer's own zone (getHours, setHours), which is UTC on Vercel.

export const NEW_YORK_TIME_ZONE = 'America/New_York'

// The push digest's hour in UTC: vercel.json runs /api/push/digest at "0 12 * * *". A unit test
// (lib/time/__tests__/newYork.unit.test.ts) pins the two together, so they can't drift apart [planner].
export const DIGEST_CRON_UTC_HOUR = 12

const DAY_MS = 86_400_000

const NEW_YORK_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: NEW_YORK_TIME_ZONE,
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', second: 'numeric',
  hourCycle: 'h23',
})

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second: number }

// What a calendar and a clock on a New York wall show at the instant `ms`.
function newYorkWallClock(ms: number): WallClock {
  const parts = NEW_YORK_CLOCK.formatToParts(ms)
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === type)?.value)
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour: get('hour') % 24, // some engines write midnight as 24
    minute: get('minute'), second: get('second'),
  }
}

// How far New York's clock is from UTC at the instant `ms`: -4 hours in daylight time, -5 in winter.
function newYorkOffsetMs(ms: number): number {
  const w = newYorkWallClock(ms)
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000
}

// The instant of 00:00 in New York on `now`'s New York calendar day. New York's midnight always exists
// and happens once (the clocks change at 2 AM), so two steps find it: take 00:00 on that date as if it
// were UTC and shift it by New York's offset there, then correct with the offset at the result.
export function startOfNewYorkDay(now: Date): Date {
  const { year, month, day } = newYorkWallClock(now.getTime())
  const midnightAsUtc = Date.UTC(year, month - 1, day)
  const guess = midnightAsUtc - newYorkOffsetMs(midnightAsUtc)
  return new Date(midnightAsUtc - newYorkOffsetMs(guess))
}

// When the push digest reaches New York, in words that stay true across daylight saving [planner]:
// "Daily at 8:00 AM New York time" in daylight time, "Daily at 7:00 AM New York time" in winter,
// worked out from DIGEST_CRON_UTC_HOUR. It describes the next digest at or after `now`, so once the
// last digest before the clocks change has gone, it already shows the new time [engineering precaution].
export function digestScheduleLabel(now: Date): string {
  let run = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DIGEST_CRON_UTC_HOUR)
  if (run < now.getTime()) run += DAY_MS // today's digest has gone: tomorrow's (a UTC day is always 24 hours)
  const { hour, minute } = newYorkWallClock(run)
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  return `Daily at ${hour12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'} New York time`
}

// Brief 48 (PR 4): the Home page's clock words, "Good morning,", "MORNING" and "MON · 14:05" [planner;
// Brief 46 S1]. The server renders Home in UTC and the phone renders it again in its own time zone, so
// clock text worked out while rendering never matched, and React threw error #418 on every load. Now
// the first render, on the server and on the phone, shows placeholders that don't depend on the clock,
// and the words come in right after the page loads, from the phone's clock and time zone as before.

const MINUTE_MS = 60_000

export interface HomeClockText {
  ready: boolean   // false until the page has loaded in the browser
  greeting: string // "Good morning,", "Good afternoon," or "Good evening,"
  period: string   // DAWN, MORNING, AFTERNOON, EVENING or NIGHT
  eyebrow: string  // the weekday and the 24-hour time, "MON · 14:05"
}

// Before the page has loaded. A non-breaking space keeps its line's height without showing anything,
// so nothing moves when the words come in; the top line shows "—", like the count beside it.
export const HOME_CLOCK_PLACEHOLDER: HomeClockText = { ready: false, greeting: ' ', period: '—', eyebrow: ' ' }

function greetWord(hour: number): string {
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  return 'evening'
}

function timePeriod(hour: number): string {
  if (hour >= 4  && hour < 7)  return 'DAWN'
  if (hour >= 7  && hour < 12) return 'MORNING'
  if (hour >= 12 && hour < 17) return 'AFTERNOON'
  if (hour >= 17 && hour < 21) return 'EVENING'
  return 'NIGHT'
}

// The clock words at `now`, or the placeholders while `now` is null (before the page has loaded).
// The page leaves `timeZone` out, so the phone's own time zone is used; tests pass one.
export function homeClockText(now: Date | null, timeZone?: string): HomeClockText {
  if (!now) return HOME_CLOCK_PLACEHOLDER
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? ''
  const hour = Number(get('hour')) % 24 // some engines write midnight as 24
  return {
    ready: true,
    greeting: `Good ${greetWord(hour)},`,
    period: timePeriod(hour),
    eyebrow: `${get('weekday').toUpperCase()} · ${String(hour).padStart(2, '0')}:${get('minute')}`,
  }
}

// A store for React's useSyncExternalStore: the start of the current minute on the phone's clock.
// React uses getServerSnapshot (null) on the server and for the phone's first render over the server's
// HTML, so both show the placeholders, then renders again with the phone's minute. subscribe wakes the
// page at each new minute, so the time shown stays current.
export const minuteClock = {
  subscribe: (onChange: () => void): (() => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const wait = () => { timer = setTimeout(() => { onChange(); wait() }, MINUTE_MS - (Date.now() % MINUTE_MS)) }
    // A phone that puts the page to sleep can hold its timer back, so the clock is read again as soon as
    // the page is shown, rather than at the next minute [engineering precaution].
    const onShow = () => {
      if (document.visibilityState !== 'visible') return
      clearTimeout(timer)
      onChange()
      wait()
    }
    const hasDocument = typeof document !== 'undefined'
    wait()
    if (hasDocument) document.addEventListener('visibilitychange', onShow)
    return () => {
      clearTimeout(timer)
      if (hasDocument) document.removeEventListener('visibilitychange', onShow)
    }
  },
  getSnapshot: (): number | null => {
    const now = Date.now()
    return now - (now % MINUTE_MS)
  },
  getServerSnapshot: (): number | null => null,
}

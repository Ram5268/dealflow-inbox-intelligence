// Brief 48 (PR 4): React error #418 on every Home load [Brief 46 S1; planner]. The server renders the
// Home page in UTC (at build time or on request) and the phone renders it again in New York time, so any
// clock text in that first render differs and React throws. This renders the real page with React's
// server renderer at different times and computer time zones: the HTML must be the same every time and
// hold no clock text. The phone's first render uses the same server snapshot, so it matches too; the
// executor checks the console in a real browser. No network: the page fetches only in effects, which
// the server renderer never runs, and fetch is refused here anyway.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { AppRouterContext, type AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime'
import GreetPage from '../../../app/page'

globalThis.fetch = (() => { throw new Error('network refused in this test') }) as typeof fetch

const router: AppRouterInstance = {
  back: () => {}, forward: () => {}, refresh: () => {}, push: () => {}, replace: () => {}, prefetch: () => {},
}

function firstRender(now: string, tz: string): string {
  const before = process.env.TZ
  process.env.TZ = tz
  mock.timers.enable({ apis: ['Date'], now: new Date(now) })
  try {
    return renderToString(
      createElement(AppRouterContext.Provider, { value: router },
        createElement(PathnameContext.Provider, { value: '/' }, createElement(GreetPage))),
    )
  } finally {
    mock.timers.reset()
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
}

test('the Home page\'s first render is the same at any time and in any time zone', () => {
  const server = firstRender('2026-10-19T12:05:00.000Z', 'UTC') // Vercel: 12:05 PM UTC, Monday
  const others: Array<[string, string, string]> = [
    ['the phone at the same moment (8:05 AM)', '2026-10-19T12:05:00.000Z', 'America/New_York'],
    ['10:59 PM in New York, already Tuesday in UTC', '2026-10-20T02:59:00.000Z', 'America/New_York'],
    ['a winter morning in New York', '2026-01-15T14:30:00.000Z', 'America/New_York'],
    ['the server one minute later', '2026-10-19T12:06:00.000Z', 'UTC'],
    ['another time zone', '2026-10-19T21:30:00.000Z', 'Asia/Tokyo'],
  ]
  for (const [what, now, tz] of others) assert.equal(firstRender(now, tz), server, what)
})

test('the Home page\'s first render holds no clock text, and the rest of the page is there', () => {
  const html = firstRender('2026-10-19T12:05:00.000Z', 'UTC')
  assert.ok(!/Good (morning|afternoon|evening)/i.test(html), 'no greeting word yet')
  assert.ok(!/\b(DAWN|MORNING|AFTERNOON|EVENING|NIGHT)\b/.test(html), 'no time-of-day label yet')
  assert.ok(!/\b(MON|TUE|WED|THU|FRI|SAT|SUN)\b/.test(html), 'no weekday yet')
  assert.ok(!/\b\d{1,2}:\d{2}\b/.test(html), 'no clock time yet')
  for (const text of ['Ryan', 'OVERNIGHT', 'CALENDAR', 'MATCHES', 'MARKET', 'Check In', 'Checking your inbox']) {
    assert.ok(html.includes(text), `still shows ${text}`)
  }
})

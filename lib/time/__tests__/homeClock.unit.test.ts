// Brief 48 (PR 4): the Home page's clock words ("Good morning,", "MORNING", "MON · 14:05") [planner;
// Brief 46 S1]. Before the page has loaded they are placeholders that don't depend on the clock, so the
// server's render and the phone's first render match (no React error #418). After that they follow the
// phone's clock, with the same cut-offs as before, and the minute store ticks once a minute.
// Pure: no browser, no network.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { HOME_CLOCK_PLACEHOLDER, homeClockText, minuteClock } from '../homeClock'

const NY = 'America/New_York'

test('before the page has loaded: the same placeholders at any time of day', () => {
  const seen: string[] = []
  for (const now of ['2026-10-19T11:05:00.000Z', '2026-10-19T19:30:00.000Z', '2026-10-20T03:59:00.000Z']) {
    mock.timers.enable({ apis: ['Date'], now: new Date(now) })
    try { seen.push(JSON.stringify(homeClockText(null))) } finally { mock.timers.reset() }
  }
  assert.equal(new Set(seen).size, 1)
  assert.deepEqual(homeClockText(null), HOME_CLOCK_PLACEHOLDER)
  assert.equal(HOME_CLOCK_PLACEHOLDER.ready, false)
})

test('the placeholders keep each line\'s height and name no time of day', () => {
  for (const text of [HOME_CLOCK_PLACEHOLDER.greeting, HOME_CLOCK_PLACEHOLDER.period, HOME_CLOCK_PLACEHOLDER.eyebrow]) {
    assert.ok(text.length > 0, 'never empty, so the line keeps its height')
    assert.ok(!/morning|afternoon|evening|night|dawn|\d/i.test(text), `${JSON.stringify(text)} names no time`)
  }
})

// [New York time on Mon Oct 19 2026 (UTC-4), greeting, period]: the same cut-offs as before.
const WORDS: Array<[string, string, string]> = [
  ['00:00', 'Good evening,', 'NIGHT'],
  ['03:59', 'Good evening,', 'NIGHT'],
  ['04:00', 'Good evening,', 'DAWN'],
  ['04:59', 'Good evening,', 'DAWN'],
  ['05:00', 'Good morning,', 'DAWN'],
  ['06:59', 'Good morning,', 'DAWN'],
  ['07:00', 'Good morning,', 'MORNING'],
  ['11:59', 'Good morning,', 'MORNING'],
  ['12:00', 'Good afternoon,', 'AFTERNOON'],
  ['16:59', 'Good afternoon,', 'AFTERNOON'],
  ['17:00', 'Good evening,', 'EVENING'],
  ['20:59', 'Good evening,', 'EVENING'],
  ['21:00', 'Good evening,', 'NIGHT'],
  ['23:59', 'Good evening,', 'NIGHT'],
]

test('after the page has loaded: the greeting and the period follow the hour', () => {
  for (const [hhmm, greeting, period] of WORDS) {
    const [h, m] = hhmm.split(':').map(Number)
    const now = new Date(Date.UTC(2026, 9, 19, h + 4, m)) // New York is UTC-4 on Oct 19
    const text = homeClockText(now, NY)
    assert.equal(text.ready, true)
    assert.equal(text.greeting, greeting, `${hhmm} greeting`)
    assert.equal(text.period, period, `${hhmm} period`)
  }
})

test('after the page has loaded: the eyebrow is the weekday and the 24-hour time on the phone\'s clock', () => {
  assert.equal(homeClockText(new Date('2026-10-19T18:05:00.000Z'), NY).eyebrow, 'MON · 14:05')
  assert.equal(homeClockText(new Date('2026-10-20T04:07:00.000Z'), NY).eyebrow, 'TUE · 00:07')
  assert.equal(homeClockText(new Date('2026-10-20T03:59:00.000Z'), NY).eyebrow, 'MON · 23:59')
  assert.equal(homeClockText(new Date('2026-10-20T04:07:00.000Z'), 'Asia/Tokyo').eyebrow, 'TUE · 13:07')
  assert.equal(homeClockText(new Date('2026-01-15T14:30:00.000Z'), NY).eyebrow, 'THU · 09:30')
})

test('after the page has loaded: the phone\'s own time zone, not the server\'s', () => {
  const now = new Date('2026-10-19T12:05:00.000Z') // 8:05 AM in New York, 12:05 PM in UTC
  assert.equal(homeClockText(now, NY).greeting, 'Good morning,')
  assert.equal(homeClockText(now, 'UTC').greeting, 'Good afternoon,')
  const before = process.env.TZ
  process.env.TZ = NY // no zone given: the computer's own zone (the phone's, in the browser)
  try { assert.equal(homeClockText(now).eyebrow, 'MON · 08:05') } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
})

test('minuteClock: nothing on the server; in the browser the current minute, ticking at each new minute', () => {
  assert.equal(minuteClock.getServerSnapshot(), null)
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-10-19T18:05:30.000Z') })
  try {
    assert.equal(minuteClock.getSnapshot(), Date.parse('2026-10-19T18:05:00.000Z'))
    assert.equal(minuteClock.getSnapshot(), minuteClock.getSnapshot(), 'the same value until the minute changes')
    let ticks = 0
    const stop = minuteClock.subscribe(() => { ticks++ })
    mock.timers.tick(29_999)
    assert.equal(ticks, 0)
    mock.timers.tick(1)
    assert.equal(ticks, 1, 'ticks at 18:06:00')
    assert.equal(minuteClock.getSnapshot(), Date.parse('2026-10-19T18:06:00.000Z'))
    mock.timers.tick(60_000)
    assert.equal(ticks, 2, 'and at 18:07:00')
    stop()
    mock.timers.tick(5 * 60_000)
    assert.equal(ticks, 2, 'no ticks after the page unsubscribes')
  } finally { mock.timers.reset() }
})

test('minuteClock: reads the clock again as soon as the page is shown, and stops listening when unsubscribed', () => {
  const listeners = new Set<() => void>()
  const fakeDocument = {
    visibilityState: 'hidden',
    addEventListener: (type: string, fn: () => void) => { if (type === 'visibilitychange') listeners.add(fn) },
    removeEventListener: (type: string, fn: () => void) => { if (type === 'visibilitychange') listeners.delete(fn) },
  }
  const g = globalThis as unknown as { document?: unknown }
  const before = g.document
  g.document = fakeDocument
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-10-19T18:05:30.000Z') })
  try {
    let ticks = 0
    const stop = minuteClock.subscribe(() => { ticks++ })
    assert.equal(listeners.size, 1)
    for (const fn of listeners) fn() // hidden: nothing
    assert.equal(ticks, 0)
    fakeDocument.visibilityState = 'visible'
    for (const fn of listeners) fn()
    assert.equal(ticks, 1, 'shown: read the clock at once')
    mock.timers.tick(30_000)
    assert.equal(ticks, 2, 'and still ticks at the next minute, once')
    stop()
    assert.equal(listeners.size, 0)
    mock.timers.tick(5 * 60_000)
    assert.equal(ticks, 2)
  } finally {
    mock.timers.reset()
    g.document = before
  }
})

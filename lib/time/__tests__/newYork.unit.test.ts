// Brief 48 (PR 4): New York time helpers [planner]. startOfNewYorkDay is the instant of 00:00 in
// New York on now's New York calendar day: right in summer and winter, on both daylight-saving days
// (2026-03-08 and 2026-11-01) and on either side of midnight, whatever the computer's own time zone
// is (Vercel runs in UTC). The digest's UTC hour is pinned to vercel.json, and its label says when the
// next digest reaches New York, so it stays true across daylight saving. Pure: no database, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIGEST_CRON_UTC_HOUR, digestScheduleLabel, startOfNewYorkDay } from '../newYork'

const HOUR = 3_600_000

// The computer's own time zone must not matter. Node picks up a change to TZ at once.
const ZONES = ['UTC', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati']
function inZone(tz: string, fn: () => void) {
  const before = process.env.TZ
  process.env.TZ = tz
  try { fn() } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
}

// [what, now, the start of that New York day]
const DAY_STARTS: Array<[string, string, string]> = [
  ['summer afternoon', '2026-07-15T16:00:00.000Z', '2026-07-15T04:00:00.000Z'],
  ['winter afternoon', '2026-01-15T16:00:00.000Z', '2026-01-15T05:00:00.000Z'],
  ['UTC midnight, still 8 PM the evening before in New York', '2026-10-19T00:00:00.000Z', '2026-10-18T04:00:00.000Z'],
  ['1 ms before New York midnight (summer)', '2026-10-19T03:59:59.999Z', '2026-10-18T04:00:00.000Z'],
  ['New York midnight (summer)', '2026-10-19T04:00:00.000Z', '2026-10-19T04:00:00.000Z'],
  ['1 ms after New York midnight (summer)', '2026-10-19T04:00:00.001Z', '2026-10-19T04:00:00.000Z'],
  ['1 ms before New York midnight (winter)', '2026-12-01T04:59:59.999Z', '2026-11-30T05:00:00.000Z'],
  ['New York midnight (winter)', '2026-12-01T05:00:00.000Z', '2026-12-01T05:00:00.000Z'],
  ['1 ms after New York midnight (winter)', '2026-12-01T05:00:00.001Z', '2026-12-01T05:00:00.000Z'],
  // 2026-03-08: at 2:00 AM EST the clocks go forward to 3:00 AM EDT (07:00 UTC).
  ['Mar 7, 11:59 PM EST', '2026-03-08T04:59:00.000Z', '2026-03-07T05:00:00.000Z'],
  ['Mar 8, midnight EST', '2026-03-08T05:00:00.000Z', '2026-03-08T05:00:00.000Z'],
  ['Mar 8, 1:59 AM EST', '2026-03-08T06:59:00.000Z', '2026-03-08T05:00:00.000Z'],
  ['Mar 8, 3:00 AM EDT, just after the change', '2026-03-08T07:00:00.000Z', '2026-03-08T05:00:00.000Z'],
  ['Mar 8, 11:59:59.999 PM EDT', '2026-03-09T03:59:59.999Z', '2026-03-08T05:00:00.000Z'],
  ['Mar 9, midnight EDT', '2026-03-09T04:00:00.000Z', '2026-03-09T04:00:00.000Z'],
  // 2026-11-01: at 2:00 AM EDT the clocks go back to 1:00 AM EST (06:00 UTC), so 1:30 AM happens twice.
  ['Oct 31, 11:59 PM EDT', '2026-11-01T03:59:00.000Z', '2026-10-31T04:00:00.000Z'],
  ['Nov 1, midnight EDT', '2026-11-01T04:00:00.000Z', '2026-11-01T04:00:00.000Z'],
  ['Nov 1, the first 1:30 AM (EDT)', '2026-11-01T05:30:00.000Z', '2026-11-01T04:00:00.000Z'],
  ['Nov 1, the second 1:30 AM (EST)', '2026-11-01T06:30:00.000Z', '2026-11-01T04:00:00.000Z'],
  ['Nov 1, 11:59:59.999 PM EST', '2026-11-02T04:59:59.999Z', '2026-11-01T04:00:00.000Z'],
  ['Nov 2, midnight EST', '2026-11-02T05:00:00.000Z', '2026-11-02T05:00:00.000Z'],
  ['New Year\'s Eve, 11:59 PM', '2027-01-01T04:59:00.000Z', '2026-12-31T05:00:00.000Z'],
  ['New Year\'s Day, midnight', '2027-01-01T05:00:00.000Z', '2027-01-01T05:00:00.000Z'],
]

test('startOfNewYorkDay: summer, winter, both daylight-saving days, either side of midnight, any computer time zone', () => {
  for (const tz of ZONES) inZone(tz, () => {
    for (const [what, now, start] of DAY_STARTS) {
      assert.equal(startOfNewYorkDay(new Date(now)).toISOString(), start, `${what} (computer in ${tz})`)
    }
  })
})

test('startOfNewYorkDay: Mar 8 2026 is 23 hours long, Nov 1 2026 is 25, other days 24', () => {
  const hours = (noon: string, nextNoon: string) =>
    (startOfNewYorkDay(new Date(nextNoon)).getTime() - startOfNewYorkDay(new Date(noon)).getTime()) / HOUR
  assert.equal(hours('2026-03-08T17:00:00Z', '2026-03-09T16:00:00Z'), 23)
  assert.equal(hours('2026-11-01T17:00:00Z', '2026-11-02T17:00:00Z'), 25)
  assert.equal(hours('2026-10-19T16:00:00Z', '2026-10-20T16:00:00Z'), 24)
  assert.equal(hours('2026-01-15T17:00:00Z', '2026-01-16T17:00:00Z'), 24)
})

test('startOfNewYorkDay: all through 2026, and minute by minute across both clock changes, it is 00:00 in New York on the same New York date', () => {
  // A second opinion from a plain formatter (never the computer's own zone).
  const ny = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  const date = (t: number) => ny.format(t).split(', ')[0]
  const clock = (t: number) => ny.format(t).split(', ')[1]
  const check = (t: number) => {
    const start = startOfNewYorkDay(new Date(t)).getTime()
    assert.ok(start <= t && t - start < 25 * HOUR, `${new Date(t).toISOString()}: start is earlier the same day`)
    assert.equal(clock(start), '00:00:00', `${new Date(t).toISOString()}: start reads midnight`)
    assert.equal(date(start), date(t), `${new Date(t).toISOString()}: same New York date`)
    assert.notEqual(date(start - 1), date(t), `${new Date(t).toISOString()}: 1 ms earlier is the day before`)
  }
  inZone('UTC', () => {
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 61 * 60_000) check(t)
    // 10 PM the evening before to 2 AM the day after, each change day.
    for (const [from, to] of [['2026-03-08T03:00:00Z', '2026-03-09T06:00:00Z'], ['2026-11-01T02:00:00Z', '2026-11-02T07:00:00Z']]) {
      for (let t = Date.parse(from); t <= Date.parse(to); t += 60_000) check(t)
    }
  })
})

test('startOfNewYorkDay returns a new Date and leaves its input alone', () => {
  const now = new Date('2026-10-19T15:00:00.000Z')
  const start = startOfNewYorkDay(now)
  assert.notEqual(start, now)
  assert.equal(now.toISOString(), '2026-10-19T15:00:00.000Z')
})

test('DIGEST_CRON_UTC_HOUR matches vercel.json\'s daily schedule for /api/push/digest', () => {
  const vercel = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'vercel.json'), 'utf8')) as {
    crons?: Array<{ path: string; schedule: string }>
  }
  const digest = (vercel.crons ?? []).filter(c => c.path === '/api/push/digest')
  assert.equal(digest.length, 1, 'vercel.json has one /api/push/digest cron')
  const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] = digest[0].schedule.trim().split(/\s+/)
  assert.equal(rest.length, 0, 'five cron fields')
  assert.equal(minute, '0', 'on the hour, as the label assumes')
  assert.equal(hour, String(DIGEST_CRON_UTC_HOUR), 'one fixed UTC hour, the same as DIGEST_CRON_UTC_HOUR')
  assert.deepEqual([dayOfMonth, month, dayOfWeek], ['*', '*', '*'], 'every day')
  assert.equal(DIGEST_CRON_UTC_HOUR, 12)
})

// [what, now, label]. The label describes the next digest at or after now.
const LABELS: Array<[string, string, string]> = [
  ['summer', '2026-07-15T10:00:00.000Z', 'Daily at 8:00 AM New York time'],
  ['winter', '2026-01-15T10:00:00.000Z', 'Daily at 7:00 AM New York time'],
  ['today, Oct 19 (daylight time)', '2026-10-19T15:00:00.000Z', 'Daily at 8:00 AM New York time'],
  ['the moment the digest runs', '2026-07-15T12:00:00.000Z', 'Daily at 8:00 AM New York time'],
  ['1 ms before New York midnight (summer)', '2026-10-19T03:59:59.999Z', 'Daily at 8:00 AM New York time'],
  ['1 ms after New York midnight (summer)', '2026-10-19T04:00:00.001Z', 'Daily at 8:00 AM New York time'],
  ['1 ms before New York midnight (winter)', '2026-12-01T04:59:59.999Z', 'Daily at 7:00 AM New York time'],
  ['1 ms after New York midnight (winter)', '2026-12-01T05:00:00.001Z', 'Daily at 7:00 AM New York time'],
  // Clocks go forward on Mar 8: that morning's digest is the first at 8:00.
  ['Mar 7, 6 AM EST, before that day\'s 7:00 digest', '2026-03-07T11:00:00.000Z', 'Daily at 7:00 AM New York time'],
  ['Mar 7, 3 PM EST, the next digest is Mar 8 at 8:00', '2026-03-07T20:00:00.000Z', 'Daily at 8:00 AM New York time'],
  ['Mar 8, 12:30 AM EST, before the change', '2026-03-08T05:30:00.000Z', 'Daily at 8:00 AM New York time'],
  ['Mar 8, 1 PM EDT', '2026-03-08T17:00:00.000Z', 'Daily at 8:00 AM New York time'],
  // Clocks go back on Nov 1: that morning's digest is the first at 7:00.
  ['Oct 31, 7 AM EDT, before that day\'s 8:00 digest', '2026-10-31T11:00:00.000Z', 'Daily at 8:00 AM New York time'],
  ['Oct 31, 2 PM EDT, the next digest is Nov 1 at 7:00', '2026-10-31T18:00:00.000Z', 'Daily at 7:00 AM New York time'],
  ['Nov 1, 12:30 AM EDT, still daylight time', '2026-11-01T04:30:00.000Z', 'Daily at 7:00 AM New York time'],
  ['Nov 1, 1 PM EST', '2026-11-01T18:00:00.000Z', 'Daily at 7:00 AM New York time'],
]

test('digestScheduleLabel: 8:00 AM in daylight time, 7:00 AM in winter, right around both changes and midnight', () => {
  for (const tz of ZONES) inZone(tz, () => {
    for (const [what, now, label] of LABELS) {
      assert.equal(digestScheduleLabel(new Date(now)), label, `${what} (computer in ${tz})`)
    }
  })
})

test('digestScheduleLabel is plain words for Ryan', () => {
  const label = digestScheduleLabel(new Date('2026-10-19T15:00:00.000Z'))
  assert.ok(!/[!—]/.test(label), 'no exclamation mark or em dash')
  assert.ok(!/UTC|ET\b|EDT|EST|cron/i.test(label), 'no time-zone codes or system words')
})

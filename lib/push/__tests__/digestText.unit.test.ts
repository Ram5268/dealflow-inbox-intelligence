// Brief 48 (PR 5): the words of the morning digest and the HOT alert. Counts only:
// no buyer's or homeowner's name, no address, no run of 10 digits [planner, Brief 48
// §3 PR 5]. A quiet morning says nothing about the inbox, since email reading is
// paused [Ryan, 2026-09-24]. Pure: no database, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { digestText, hotAlertText } from '../digestText'

const counts = (hot: number, warm: number, possible: number) => ({ hot, warm, possible })
const tenDigits = (s: string) => /\d{10}/.test(s) || /\d{10}/.test(s.replace(/[\s.\-()[\]]/g, ''))

test('counts by tier, Hot first, empty tiers left out', () => {
  assert.deepEqual(digestText(counts(1, 2, 0)), { title: 'Morning matches', body: '3 new matches overnight: 1 Hot, 2 Warm. Open DealFlow.' })
  assert.equal(digestText(counts(2, 0, 5)).body, '7 new matches overnight: 2 Hot, 5 Possible. Open DealFlow.')
  assert.equal(digestText(counts(0, 0, 1)).body, '1 new match overnight: 1 Possible. Open DealFlow.')
  assert.equal(digestText(counts(1, 1, 1)).body, '3 new matches overnight: 1 Hot, 1 Warm, 1 Possible. Open DealFlow.')
})

test('a quiet morning is plain and says nothing about the inbox', () => {
  const t = digestText(counts(0, 0, 0))
  assert.deepEqual(t, { title: 'Quiet morning', body: 'No new matches overnight. Open DealFlow.' })
  assert.ok(!/inbox|synced/i.test(`${t.title} ${t.body}`))
})

test('large counts are grouped, so no run of digits forms', () => {
  assert.equal(digestText(counts(8213, 1200, 0)).body, '9,413 new matches overnight: 8,213 Hot, 1,200 Warm. Open DealFlow.')
  let seed = 48
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  for (let i = 0; i < 2000; i++) {
    const c = counts(rand() % 10 ** (1 + (i % 9)), rand() % 10 ** (1 + ((i + 3) % 9)), rand() % 10 ** (1 + ((i + 5) % 9)))
    const t = digestText(c)
    assert.ok(!tenDigits(`${t.title} ${t.body}`), `${JSON.stringify(c)}: ${t.body}`)
  }
})

test('the HOT alert is a count too', () => {
  assert.deepEqual(hotAlertText(), { title: 'New Hot match', body: '1 new Hot match. Open DealFlow.' })
})

test('calm wording: no exclamation marks, no em-dashes, no system words', () => {
  const all = [digestText(counts(0, 0, 0)), digestText(counts(3, 2, 1)), digestText(counts(0, 0, 1)), hotAlertText()]
  for (const t of all) {
    const s = `${t.title} ${t.body}`
    assert.ok(!/[!—]/.test(s), s)
    assert.ok(!/mojo|isTestData|endpoint|VAPID|tier|score/i.test(s), s)
  }
})

// Brief 43 PR 14 (Q29, M21): the chat's starter chips only promise what Drift's
// search can do. Search can't find price drops (no such listing category), so
// there is no price-drop chip; a time window ("last 24 hours") appears only on a
// chip whose count says something came in, and search filters by that date
// (createdAfter). The fallback chips, shown when nothing came in recently, ask
// for things search always answers. Feel standard (Brief 42 TEST_PLAN §3): no
// em-dash, no "!", no system words such as "opportunity". Pure; no database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildChips, FALLBACK_CHIPS } from '../chips'

const NONE = { recent: 0, comingSoonOrOffMarket: 0, buyerISO: 0, rentalNew: 0 }

test('nothing recent: the fallback chips, exactly', () => {
  assert.deepEqual(buildChips(NONE), FALLBACK_CHIPS)
  assert.deepEqual(FALLBACK_CHIPS, [
    { label: 'Newest listings', query: 'Show me the newest listings on file.' },
    { label: 'Coming soon listings', query: 'Show me all coming soon listings in the database.' },
    { label: 'Buyer ISO matches', query: 'Show me all buyer ISOs and check if any match my current listings.' },
    { label: 'Off-market deals', query: 'Show me all off-market deals in my inbox.' },
  ])
})

test('the fallback chips promise no time window (nothing came in recently)', () => {
  for (const c of FALLBACK_CHIPS) assert.doesNotMatch(`${c.label} ${c.query}`, /this week|today|24 hours|48 hours|overnight|came in/i, c.label)
})

test('counts give dated chips, at most 4, and never a price-drop chip', () => {
  const chips = buildChips({ recent: 3, comingSoonOrOffMarket: 2, buyerISO: 1, rentalNew: 5 })
  assert.equal(chips.length, 4)
  assert.deepEqual(chips.map(c => c.label), ['3 new in the last 24 hours', '2 coming soon & off-market', '1 buyer ISO to match', '5 new rentals'])
  assert.equal(chips[0].query, 'What came in over the last 24 hours? Summarize it.')
  assert.equal(chips[2].query, 'Show me the buyer ISOs from the last 48 hours. What are they looking for, and do any match my listings?')
  for (const c of [...chips, ...FALLBACK_CHIPS]) {
    const text = `${c.label} ${c.query}`
    assert.doesNotMatch(text, /price drop/i, c.label)
    assert.doesNotMatch(text, /opportunit/i, c.label)
    assert.ok(!text.includes('—') && !text.includes('!'), c.label)
  }
})

test('one count alone gives one chip', () => {
  assert.deepEqual(buildChips({ ...NONE, rentalNew: 1 }), [{ label: '1 new rental', query: 'Show me the new rental listings from the last 48 hours.' }])
})

test('the chips route builds its chips with buildChips and no longer counts price drops', () => {
  const src = readFileSync(join(__dirname, '../../../app/api/chat/chips/route.ts'), 'utf8')
  assert.match(src, /buildChips\(/)
  assert.doesNotMatch(src, /PRICE_DROP/)
})

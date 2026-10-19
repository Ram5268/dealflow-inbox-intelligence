import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCORING_REFUSED_ACTION, ScoringRefusedError, scoringRefusal } from '../guard'

// Brief 47 (PR 1): the nightly's size check, pure (engineering precaution,
// Brief 40 audit M6). Sizes only, never churn.

const normal = { sellers: 1478, buyers: 250, kept: 9000, sellersCovered: 1300, existingMatches: 9100, existingSellersCovered: 1310 }

test('a normal night passes', () => {
  assert.deepEqual(scoringRefusal(normal), [])
})

test('the first night (an empty table) and a growing night pass', () => {
  assert.deepEqual(scoringRefusal({ ...normal, existingMatches: 0, existingSellersCovered: 0 }), [])
  assert.deepEqual(scoringRefusal({ ...normal, kept: 0, sellersCovered: 0, existingMatches: 0, existingSellersCovered: 0 }), [])
  assert.deepEqual(scoringRefusal({ ...normal, kept: 90_000, sellersCovered: 1478 }), [])
})

test('0 sellers or 0 buyers is refused, whatever the table holds', () => {
  const empty = { existingMatches: 0, existingSellersCovered: 0, kept: 0, sellersCovered: 0 }
  assert.deepEqual(scoringRefusal({ ...normal, ...empty, sellers: 0 }), ['no_sellers'])
  assert.deepEqual(scoringRefusal({ ...normal, ...empty, buyers: 0 }), ['no_buyers'])
  assert.deepEqual(scoringRefusal({ ...normal, ...empty, sellers: 0, buyers: 0 }), ['no_sellers', 'no_buyers'])
  // Sep 26: no buyers, so nothing kept, against a full table.
  assert.deepEqual(scoringRefusal({ ...normal, buyers: 0, kept: 0, sellersCovered: 0 }),
    ['no_buyers', 'matches_shrank', 'sellers_shrank'])
})

test('fewer than half as many matches is refused; exactly half passes', () => {
  assert.deepEqual(scoringRefusal({ ...normal, kept: 4550, existingMatches: 9100 }), [])
  assert.deepEqual(scoringRefusal({ ...normal, kept: 4549, existingMatches: 9100 }), ['matches_shrank'])
  assert.deepEqual(scoringRefusal({ ...normal, kept: 5, existingMatches: 11 }), ['matches_shrank'])
  assert.deepEqual(scoringRefusal({ ...normal, kept: 5, existingMatches: 10 }), [])
})

test('fewer than half as many sellers with a match is refused; exactly half passes', () => {
  assert.deepEqual(scoringRefusal({ ...normal, sellersCovered: 655, existingSellersCovered: 1310 }), [])
  assert.deepEqual(scoringRefusal({ ...normal, sellersCovered: 654, existingSellersCovered: 1310 }), ['sellers_shrank'])
})

test('it compares sizes only: the check never sees which pairs changed', () => {
  // A night that replaces every pair, at the same size, is the normal night to this check.
  assert.deepEqual(scoringRefusal({ ...normal, kept: normal.existingMatches, sellersCovered: normal.existingSellersCovered }), [])
  assert.deepEqual(Object.keys(normal).sort(), ['buyers', 'existingMatches', 'existingSellersCovered', 'kept', 'sellers', 'sellersCovered'])
})

test('the refusal error names the reason codes only', () => {
  const e = new ScoringRefusedError(['no_buyers', 'matches_shrank'])
  assert.ok(e instanceof Error)
  assert.equal(e.name, 'ScoringRefusedError')
  assert.equal(e.message, 'scoring refused: no_buyers, matches_shrank')
  assert.deepEqual(e.reasons, ['no_buyers', 'matches_shrank'])
  assert.equal(new ScoringRefusedError(['no_buyers']).message, 'scoring refused: no_buyers')
})

test('the AuditLog action is the one CONTRACT.md pins', () => {
  assert.equal(SCORING_REFUSED_ACTION, 'NIGHTLY_SCORING_REFUSED')
})

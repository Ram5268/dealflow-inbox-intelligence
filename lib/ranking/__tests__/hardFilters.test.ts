import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyHardFilters, type HardFilterInput } from '../hardFilters'

const base: HardFilterInput = {
  status: null, tags: [], groups: [], phones: ['(212) 555-0100'], phoneDncFlags: [false],
  matchCount: 3, allMatchesRental: false,
}
const withInput = (o: Partial<HardFilterInput>) => applyHardFilters({ ...base, ...o })

test('status DO_NOT_CALL → filtered (status_do_not_call)', () => {
  const r = withInput({ status: 'DO_NOT_CALL' })
  assert.equal(r.excluded, true)
  assert.equal(r.reason, 'status_do_not_call')
})

test('status DNC (case-insensitive) → filtered', () => {
  assert.equal(withInput({ status: 'dnc' }).reason, 'status_do_not_call')
})

test('tags include opt-out → filtered (tag_or_group_opt_out)', () => {
  assert.equal(withInput({ tags: ['seller', 'opt-out'] }).reason, 'tag_or_group_opt_out')
})

test('groups include DO_NOT_CALL → filtered', () => {
  assert.equal(withInput({ groups: ['DO_NOT_CALL'] }).reason, 'tag_or_group_opt_out')
})

test('all phones DNC → filtered (all_phones_dnc)', () => {
  assert.equal(withInput({ phones: ['a', 'b'], phoneDncFlags: [true, true] }).reason, 'all_phones_dnc')
})

test('no matches → filtered (no_matches)', () => {
  assert.equal(withInput({ matchCount: 0 }).reason, 'no_matches')
})

test('valid setup → not filtered', () => {
  assert.equal(applyHardFilters(base).excluded, false)
})

// Brief 48 (PR 9 review r1; executor, 2026-10-23): tags now come from the CRM too, written
// however an upload wrote them, so do-not-call tags are matched by their words.
test('a do-not-call tag or group in any spelling → filtered; every old spelling still is; other tags are not', () => {
  for (const tag of ['Do Not Call', 'do-not-call', 'DO_NOT_CALL', 'Opted Out', 'opted_out', 'Opt Out', 'opt-out', 'DNC', 'dnc list', 'Federal DNC']) {
    assert.equal(withInput({ tags: ['Absentee', tag] }).reason, 'tag_or_group_opt_out', tag)
    assert.equal(withInput({ groups: [tag] }).reason, 'tag_or_group_opt_out', tag)
  }
  for (const tag of ['Absentee', 'Expired', 'Out of State', 'Tired Landlord', 'Call back', 'Do call', 'ryan_listing', 'Optimist']) {
    assert.equal(withInput({ tags: [tag] }).excluded, false, tag)
  }
})

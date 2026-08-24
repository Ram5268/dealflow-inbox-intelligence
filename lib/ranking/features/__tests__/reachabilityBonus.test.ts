import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeReachabilityBonus } from '../reachabilityBonus'
import { makeAgg } from '../../__tests__/fixtures'

// phones = [primary, ...additional], aligned with phoneDncFlags + phoneTypes.
const s = (phone: string | null, additionalPhones: string[], phoneDncFlags: boolean[], phoneTypes: string[]) =>
  computeReachabilityBonus(makeAgg({ contact: { phone, additionalPhones, phoneDncFlags, phoneTypes } })).score

test('reachabilityBonus by non-DNC phone mix', () => {
  assert.equal(s('a', ['b', 'c'], [false, false, false], ['mobile', 'mobile', 'mobile']), 1.0) // 3 mobile
  assert.equal(s('a', ['b'], [false, false], ['mobile', 'mobile']), 0.85) // 2 mobile
  assert.equal(s('a', ['b'], [false, false], ['mobile', 'landline']), 0.7) // 1 mobile + 1 landline
  assert.equal(s('a', [], [false], ['mobile']), 0.55) // 1 mobile only
  assert.equal(s('a', [], [false], ['landline']), 0.35) // landline only
  assert.equal(s('a', [], [true], ['mobile']), 0.05) // all DNC → fallback
})

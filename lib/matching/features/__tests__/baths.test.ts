import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeBaths } from '../baths'
import { makeListing, makeBuyer } from '../../__tests__/fixtures'

// Brief 32.A.1 — baths now scores against buyer bathsMin/bathsMax. Exact table.
const call = (baths: number | null, bathsMin: number | null, bathsMax: number | null) =>
  computeBaths(makeListing({ baths }), makeBuyer({ bathsMin, bathsMax }))

test('baths scoring table (exact)', () => {
  assert.deepEqual(call(2, 2, null), { key: 'baths', score: 1.0, confidence: 'HIGH' })
  assert.deepEqual(call(2.5, 2, null), { key: 'baths', score: 1.0, confidence: 'HIGH' })
  assert.deepEqual(call(1.5, 2, null), { key: 'baths', score: 0.7, confidence: 'HIGH' }) // within 0.5
  assert.deepEqual(call(1, 2, null), { key: 'baths', score: 0.3, confidence: 'HIGH' }) // within 1
  assert.deepEqual(call(1, 3, null), { key: 'baths', score: 0.05, confidence: 'HIGH' }) // beyond ±1
  assert.deepEqual(call(3, null, 2), { key: 'baths', score: 0.3, confidence: 'HIGH' }) // above max, within +1
  assert.deepEqual(call(2, null, null), { key: 'baths', score: 0.7, confidence: 'MEDIUM' }) // no preference
  assert.deepEqual(call(null, 2, null), { key: 'baths', score: 0.5, confidence: 'LOW' }) // listing unknown
})

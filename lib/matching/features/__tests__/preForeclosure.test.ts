import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePreForeclosure } from '../preForeclosure'
import { makeListing } from '../../__tests__/fixtures'

test('preForeclosure scoring table', () => {
  const cases: [string | null, number, string][] = [
    ['LIS_PENDENS', 0.75, 'HIGH'],
    ['NOTICE_OF_DEFAULT', 0.85, 'HIGH'],
    ['AUCTION_SCHEDULED', 1.0, 'HIGH'],
    ['NONE', 0.3, 'HIGH'],
    [null, 0.5, 'LOW'],
  ]
  for (const [status, score, conf] of cases) {
    const r = computePreForeclosure(makeListing({ preForeclosureStatus: status }))
    assert.equal(r.score, score, `${status}`)
    assert.equal(r.confidence, conf, `${status}`)
  }
})

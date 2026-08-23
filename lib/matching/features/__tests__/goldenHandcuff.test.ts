import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeGoldenHandcuff } from '../goldenHandcuff'
import { makeListing } from '../../__tests__/fixtures'

test('goldenHandcuff scoring table', () => {
  const cases: [number | null, number, string][] = [
    [3.0, 0.1, 'HIGH'],
    [4.5, 0.5, 'HIGH'],
    [7.0, 1.0, 'HIGH'],
    [null, 0.5, 'LOW'],
  ]
  for (const [rate, score, conf] of cases) {
    const r = computeGoldenHandcuff(makeListing({ loanInterestRate: rate }))
    assert.equal(r.score, score, `rate ${rate}`)
    assert.equal(r.confidence, conf, `rate ${rate}`)
  }
})

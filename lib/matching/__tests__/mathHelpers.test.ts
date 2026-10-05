import { test } from 'node:test'
import assert from 'node:assert/strict'
import { logit, sigmoid, fromLogit } from '../mathHelpers'

// Brief 32 — verification values reproduced from the brief spec.
test('logit boundary + midpoint values', () => {
  assert.ok(Math.abs(logit(1.0) - 4.615) < 0.001, `logit(1)=${logit(1.0)}`)
  assert.equal(logit(0.5), 0)
  assert.ok(Math.abs(logit(0.0) - -4.615) < 0.001, `logit(0)=${logit(0.0)}`)
})

test('logit clamps out-of-range input to [0,1]', () => {
  assert.equal(logit(2.0), logit(1.0))
  assert.equal(logit(-1.0), logit(0.0))
})

test('sigmoid midpoint + tails', () => {
  assert.equal(sigmoid(0), 0.5)
  assert.ok(Math.abs(sigmoid(4.6) - 0.99) < 0.005, `sigmoid(4.6)=${sigmoid(4.6)}`)
  assert.ok(Math.abs(sigmoid(-4.6) - 0.01) < 0.005, `sigmoid(-4.6)=${sigmoid(-4.6)}`)
})

test('logit/sigmoid are inverses around the EPS-smoothed midpoint', () => {
  assert.ok(Math.abs(sigmoid(logit(0.5)) - 0.5) < 1e-9)
})

test('fromLogit inverts logit across [0,1] and clamps beyond it', () => {
  for (const s of [0, 0.02, 0.25, 0.5, 0.81, 0.99, 1]) {
    assert.ok(Math.abs(fromLogit(logit(s)) - s) < 1e-9, `fromLogit(logit(${s}))=${fromLogit(logit(s))}`)
  }
  assert.equal(fromLogit(50), 1)
  assert.equal(fromLogit(-50), 0)
})

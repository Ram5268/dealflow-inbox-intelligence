import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeTenure } from '../tenure'
import { makeListing } from '../../__tests__/fixtures'

const now = new Date('2026-08-23T00:00:00Z')
const yearsAgo = (y: number) => new Date(now.getTime() - y * 365.25 * 86400000)

test('tenure scoring table', () => {
  assert.equal(computeTenure(makeListing({ lastSaleDate: yearsAgo(30) }), now).score, 1.0)
  assert.equal(computeTenure(makeListing({ lastSaleDate: yearsAgo(3) }), now).score, 0.3)
  assert.equal(computeTenure(makeListing({ lastSaleDate: yearsAgo(1) }), now).score, 0.1)
  const unknown = computeTenure(makeListing({ lastSaleDate: null }), now)
  assert.equal(unknown.score, 0.5)
  assert.equal(unknown.confidence, 'LOW')
})

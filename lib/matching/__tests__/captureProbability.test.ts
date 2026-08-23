import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeCaptureProbability } from '../features/captureProbability'
import { makeListing, makeBuyer, makeContext } from './fixtures'

const listing = makeListing({ id: 'L' })
const buyer = makeBuyer({ id: 'B' })

test('owned listing + represented buyer → 1.0', () => {
  const ctx = makeContext({ ryanOwnedListingIds: new Set(['L']), ryanRepresentedBuyerIds: new Set(['B']) })
  assert.equal(computeCaptureProbability(listing, buyer, ctx), 1.0)
})

test('owned listing + external buyer → 0.6', () => {
  const ctx = makeContext({ ryanOwnedListingIds: new Set(['L']) })
  assert.equal(computeCaptureProbability(listing, buyer, ctx), 0.6)
})

test('external listing + represented buyer → 0.55', () => {
  const ctx = makeContext({ ryanRepresentedBuyerIds: new Set(['B']) })
  assert.equal(computeCaptureProbability(listing, buyer, ctx), 0.55)
})

test('both external → 0.25', () => {
  assert.equal(computeCaptureProbability(listing, buyer, makeContext()), 0.25)
})

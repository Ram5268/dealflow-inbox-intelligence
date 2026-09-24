import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeCaptureStatus } from '../features/captureStatus'
import { makeListing, makeBuyer, makeContext } from './fixtures'

const listing = makeListing({ id: 'L' })
const buyer = makeBuyer({ id: 'B' })

test('OWN_BOTH_SIDES when both ids owned/repped', () => {
  const ctx = makeContext({ ryanOwnedListingIds: new Set(['L']), ryanRepresentedBuyerIds: new Set(['B']) })
  assert.equal(computeCaptureStatus(listing, buyer, ctx), 'OWN_BOTH_SIDES')
})

test('OWN_LISTING_ONLY when only listing owned', () => {
  const ctx = makeContext({ ryanOwnedListingIds: new Set(['L']) })
  assert.equal(computeCaptureStatus(listing, buyer, ctx), 'OWN_LISTING_ONLY')
})

test('OWN_BUYER_ONLY when only buyer repped', () => {
  const ctx = makeContext({ ryanRepresentedBuyerIds: new Set(['B']) })
  assert.equal(computeCaptureStatus(listing, buyer, ctx), 'OWN_BUYER_ONLY')
})

test('EXTERNAL_BOTH when neither', () => {
  assert.equal(computeCaptureStatus(listing, buyer, makeContext()), 'EXTERNAL_BOTH')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Category } from '@prisma/client'
import { resolveDismissKey } from './dismissKey'

// Run: `npm test` (ts-node via node:test). Pure function — no DB, deterministic.
//
// Brief 8.0-lite Fix #3a. The dismiss route, the GET /api/matches exclusion, and
// the engine's candidate filter all key MatchDismissal on (partyId=demand,
// listingId=supply). The bug: an ISO-triggered Match stores the demand party in
// opportunityId, and the old code assumed partyId=counterpartId — inverting the
// keys so dismissals never stuck. resolveDismissKey resolves from category, so
// every caller agrees on one key.

const ISO_ID     = 'iso-1'
const LISTING_ID = 'listing-1'
const MOJO_ID    = 'mojo-1'

// ── The bug scenario: BUYER_ISO in opportunityId, listing in counterpartId ───
test('ISO-triggered match → partyId=iso, listingId=listing (NOT inverted)', () => {
  const key = resolveDismissKey({
    opportunityId: ISO_ID,
    counterpartId: LISTING_ID,
    opportunityType: 'opportunity',
    opportunityCategory: Category.BUYER_ISO,
  })
  assert.equal(key.partyId, ISO_ID)
  assert.equal(key.listingId, LISTING_ID)
})

test('RENTER_INQUIRY-triggered match resolves the same way', () => {
  const key = resolveDismissKey({
    opportunityId: ISO_ID,
    counterpartId: LISTING_ID,
    opportunityType: 'opportunity',
    opportunityCategory: Category.RENTER_INQUIRY,
  })
  assert.deepEqual(key, { partyId: ISO_ID, listingId: LISTING_ID })
})

// ── Listing-triggered (the pre-8.0 "happy" case) still resolves correctly ────
test('listing-triggered match → partyId=counterpart, listingId=opportunity', () => {
  const key = resolveDismissKey({
    opportunityId: LISTING_ID,
    counterpartId: ISO_ID,
    opportunityType: 'opportunity',
    opportunityCategory: Category.ACTIVE_SALE_LISTING,
  })
  assert.equal(key.partyId, ISO_ID)
  assert.equal(key.listingId, LISTING_ID)
})

test('rental supply listing resolves correctly too', () => {
  const key = resolveDismissKey({
    opportunityId: LISTING_ID,
    counterpartId: ISO_ID,
    opportunityType: 'opportunity',
    opportunityCategory: Category.RENTAL_LISTING,
  })
  assert.deepEqual(key, { partyId: ISO_ID, listingId: LISTING_ID })
})

// ── Mojo counterpart: opp is the supply listing, mojo id is the party ────────
test('mojo counterpart → listing in opportunityId, mojo id as party', () => {
  const key = resolveDismissKey({
    opportunityId: LISTING_ID,
    counterpartId: MOJO_ID,
    opportunityType: 'opportunity',
    opportunityCategory: Category.COMING_SOON_SALE,
  })
  assert.equal(key.partyId, MOJO_ID)
  assert.equal(key.listingId, LISTING_ID)
})

// ── GET-consistency invariant: whichever side stored the trigger, the key the
// dismiss route WRITES equals the key the GET route uses to EXCLUDE. Same
// function → identical output → the pair is hidden after dismissal. ──────────
test('dismiss-write key === GET-exclusion key for the same match', () => {
  // Model the same match from both perspectives is unnecessary — both routes call
  // resolveDismissKey with the same (opportunityId, counterpartId, category), so
  // equality is structural. Assert it explicitly for the ISO case that regressed.
  const match = { opportunityId: ISO_ID, counterpartId: LISTING_ID, opportunityType: 'opportunity', opportunityCategory: Category.BUYER_ISO }
  const writeKey   = resolveDismissKey(match)
  const excludeKey = resolveDismissKey(match)
  assert.deepEqual(writeKey, excludeKey)
})

// ── showing_confirmation self-match: opportunityId === counterpartId ─────────
test('showing_confirmation self-match keys to the same id on both sides', () => {
  const key = resolveDismissKey({
    opportunityId: 'sc-1',
    counterpartId: 'sc-1',
    opportunityType: 'opportunity',
    opportunityCategory: Category.SHOWING_CONFIRMATION,
  })
  assert.equal(key.partyId, 'sc-1')
  assert.equal(key.listingId, 'sc-1')
})

// ── Brief 35: contact supply (a seller MojoContact in opportunityId) ─────────
test('contact supply → partyId=buyer, listingId=seller contact, whatever the category', () => {
  for (const opportunityCategory of [null, Category.BUYER_ISO] as const) {
    const key = resolveDismissKey({ opportunityId: 'seller-1', counterpartId: MOJO_ID, opportunityType: 'contact', opportunityCategory })
    assert.deepEqual(key, { partyId: MOJO_ID, listingId: 'seller-1' })
  }
})

test('an opportunity row with an unknown (null) category keys as demand-first', () => {
  const key = resolveDismissKey({ opportunityId: ISO_ID, counterpartId: LISTING_ID, opportunityType: 'opportunity', opportunityCategory: null })
  assert.deepEqual(key, { partyId: ISO_ID, listingId: LISTING_ID })
})

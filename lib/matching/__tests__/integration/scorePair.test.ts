import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scorePair } from '../../scorer'
import { makeListing, makeBuyer, makeContext } from '../fixtures'

const NOW = new Date('2026-08-23T00:00:00Z')
const daysFromNow = (d: number) => new Date(NOW.getTime() + d * 86400000)
const yearsAgo = (y: number) => new Date(NOW.getTime() - y * 365.25 * 86400000)
const ctx = makeContext({ now: NOW })

// A distressed, high-equity, absentee Chelsea seller (MojoContact-derived).
function distressedSeller(over = {}) {
  return makeListing({
    id: 'seller-1', sourceType: 'contact', transactionType: 'SALE',
    neighborhood: 'Chelsea', price: 1_500_000, beds: 2, baths: 2, propertyType: 'condo',
    preForeclosureStatus: 'AUCTION_SCHEDULED', foreclosureAuctionDate: daysFromNow(20),
    estimatedValue: 1_500_000, equityBalance: 1_300_000, // 87% equity
    ownerOccupied: false, address: '1 W 20th St, New York NY', alternateAddress: '9 Palm Ave, Miami FL',
    lastSaleDate: yearsAgo(25), mojoList: 'NYC Pre-Foreclosure', createdAt: NOW,
    ...over,
  })
}

const cashBuyer = makeBuyer({
  id: 'cash', buyerArchetype: 'CASH_BUYER', neighborhoods: ['Chelsea'],
  priceMin: 1_300_000, priceMax: 1_800_000, bedsMin: 2, bedsMax: 3, propertyTypes: ['condo'],
})

test('pre-foreclosure + cash-buyer + matching nbhd/price → still HOT tier (>= 80)', () => {
  // Post Brief 32.A.1 retune (lower motivation weights + -0.5 bias) this drops from
  // the high-90s but must remain HOT — the signal stack is genuinely strong.
  const r = scorePair(distressedSeller(), cashBuyer, ctx)
  assert.equal(r.eligibility.eligible, true)
  assert.ok(r.matchFit.matchFit >= 80, `matchFit was ${r.matchFit.matchFit}`)
})

test('same seller × TRADITIONAL_FINANCING buyer → lower matchFit than cash', () => {
  const cash = scorePair(distressedSeller(), cashBuyer, ctx).matchFit.matchFit
  const tradBuyer = makeBuyer({ ...cashBuyer, id: 'trad', buyerArchetype: 'TRADITIONAL_FINANCING' })
  const trad = scorePair(distressedSeller(), tradBuyer, ctx).matchFit.matchFit
  assert.ok(trad < cash, `trad ${trad} should be < cash ${cash}`)
})

test('currently-listed property → matchFit 0 and reason currently_listed', () => {
  const r = scorePair(distressedSeller({ priorListingStatus: 'ACTIVE' }), cashBuyer, ctx)
  assert.equal(r.matchFit.matchFit, 0)
  assert.equal(r.eligibility.eligible, false)
  assert.equal(r.eligibility.reason, 'currently_listed')
})

test('golden-handcuff owner scores meaningfully lower than an unlocked twin', () => {
  // A neutral, non-distressed seller (strong motivation signals abstain) so the
  // pair sits off the sigmoid's saturated top and the 0.9-weight handcuff has
  // visible leverage. Identical except the mortgage rate.
  const neutral = (rate: number) => makeListing({
    id: 'neutral', sourceType: 'contact', transactionType: 'SALE',
    neighborhood: 'Chelsea', price: 1_500_000, beds: 2, baths: 2, propertyType: 'condo',
    preForeclosureStatus: 'NONE', createdAt: NOW, loanInterestRate: rate,
  })
  const unlocked = scorePair(neutral(7.0), cashBuyer, ctx).matchFit.matchFit // gh 1.0
  const handcuffed = scorePair(neutral(3.0), cashBuyer, ctx).matchFit.matchFit // gh 0.1
  assert.ok(unlocked - handcuffed >= 2, `unlocked ${unlocked} vs handcuffed ${handcuffed}`)
})

test('captureStatus reflects representation posture (categorical, not a number)', () => {
  const owned = makeContext({ now: NOW, ryanOwnedListingIds: new Set(['seller-1']), ryanRepresentedBuyerIds: new Set(['cash']) })
  assert.equal(scorePair(distressedSeller(), cashBuyer, owned).captureStatus, 'OWN_BOTH_SIDES')
  assert.equal(scorePair(distressedSeller(), cashBuyer, ctx).captureStatus, 'EXTERNAL_BOTH')
})

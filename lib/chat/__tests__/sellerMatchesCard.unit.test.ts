import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buyerWants, tierOf, matchLink, isSellerMatchesCard, type BuyerFacts } from '../sellerMatchesCard'

// Brief 43 PR 6: the buyer line on the matches card reads like the CRM card's
// "Matching buyers" line (the CRM's buyerWants, src/lib/core-data/dealflow-sync/
// buyers.ts), so Drift, the chat card and the CRM card describe a buyer alike.
const none: BuyerFacts = { neighborhoods: [], propertyTypes: [], bedsMin: null, bedsMax: null, priceMin: null, priceMax: null, buyerArchetype: null }

test('buyerWants: type, areas, bedrooms, budget and how they buy, in the CRM card\'s words', () => {
  assert.equal(
    buyerWants({ ...none, propertyTypes: ['2-Family', 'Three-Family', 'Fourplex'], neighborhoods: ['Bedford-Stuyvesant', 'Crown Heights'], bedsMin: 3, priceMin: 1_350_000, priceMax: 2_600_000, buyerArchetype: 'CASH_BUYER' }),
    '2–4 family · Bedford-Stuyvesant, Crown Heights · 3+ BR · $1.35M–$2.6M · cash',
  )
  assert.equal(buyerWants({ ...none, propertyTypes: ['2-Family', '4-Family'] }), '2-family, 4-family')
  assert.equal(buyerWants({ ...none, propertyTypes: ['SFH', 'Coop'], bedsMin: 2, bedsMax: 2 }), 'Single-family, co-op · 2 BR')
  assert.equal(buyerWants({ ...none, neighborhoods: ['A', 'B', 'C', 'D', 'E'] }), 'A, B, C, +2')
  assert.equal(buyerWants({ ...none, priceMax: 2_000_000, bedsMax: 3 }), 'Up to 3 BR · up to $2M')
  assert.equal(buyerWants({ ...none, priceMin: 950_000 }), '$950K+')
  assert.equal(buyerWants({ ...none, buyerArchetype: 'EXCHANGE_1031' }), '1031 exchange')
  assert.equal(buyerWants({ ...none, buyerArchetype: 'SOME_NEW_KIND' }), 'Some new kind')
  assert.equal(buyerWants(none), 'Criteria not on file')
})

test('tierOf: the stored tier, else the tier thresholds (HOT 80+, WARM 65+)', () => {
  assert.equal(tierOf({ tier: 'WARM', score: 95 }), 'WARM')
  assert.equal(tierOf({ tier: null, score: 80 }), 'HOT')
  assert.equal(tierOf({ tier: null, score: 79 }), 'WARM')
  assert.equal(tierOf({ tier: null, score: 65 }), 'WARM')
  assert.equal(tierOf({ tier: null, score: 64 }), 'POSSIBLE')
})

test('matchLink: the /matches deep link that pins that exact match (Brief 38)', () => {
  assert.equal(matchLink('cm_abc'), '/matches?m=cm_abc')
  assert.equal(matchLink('a b&c'), '/matches?m=a%20b%26c')
})

test('isSellerMatchesCard tells the matches card from a contact card and a deal', () => {
  assert.equal(isSellerMatchesCard({ kind: 'seller_matches', seller: { kind: 'crm_seller' }, buyers: [] }), true)
  assert.equal(isSellerMatchesCard({ kind: 'crm_seller', crmUrl: null }), false)
  assert.equal(isSellerMatchesCard({ id: 'SEED_SALE_06' }), false)
  assert.equal(isSellerMatchesCard(null), false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Category } from '@prisma/client'
import { criteriaSection } from '../sections/criteria'
import type { GenContext, BuyerRecord, MatchedListing } from '../../types'

// Run via `npm test`. Pure — a mock GenContext, no DB, no network.
// The criteria section is deterministic: it just restates the buyer's fields.

function mockBuyer(over: Partial<BuyerRecord> = {}): BuyerRecord {
  return {
    id: 'buyer_1',
    category: Category.BUYER_ISO,
    name: 'Sarah Chen',
    neighborhoods: ['Soho'],
    borough: 'Manhattan',
    minBeds: 2, maxBeds: 2, beds: null,
    minPrice: 4_250_000, maxPrice: 4_750_000, price: null,
    mustHaves: 'outdoor space', dealbreakers: null, timeline: 'spring',
    propertyTypes: ['condo'], isTestData: true, createdAt: new Date('2026-08-10T00:00:00Z'),
    ...over,
  }
}

function mockCtx(buyer: BuyerRecord, matches: MatchedListing[] = []): GenContext {
  return { buyerId: buyer.id, prisma: {} as GenContext['prisma'], buyer, matches: async () => matches }
}

test('criteria section restates the buyer brief with no invention', async () => {
  const r = await criteriaSection(mockCtx(mockBuyer()))
  assert.equal(r.key, 'criteria')
  assert.equal(r.title, 'Criteria of record')
  assert.ok(r.content.prose?.includes('Sarah Chen'), 'names the buyer')
  assert.ok(r.content.prose?.includes('Soho'), 'includes the neighborhood')
  assert.ok(r.content.prose?.includes('2BR'), 'includes the bed count')
  assert.ok(r.content.prose?.includes('$4,250,000'), 'includes the budget floor')
  assert.ok(r.content.prose?.includes('outdoor space'), 'includes must-haves when present')
  assert.equal(r.content.metrics?.length, 4)
  assert.equal(r.sources[0].type, 'inbox')
  assert.equal(r.sources[0].id, 'buyer_1')
})

test('criteria section reports missing fields as "not on file", never invented', async () => {
  const bare = mockBuyer({
    neighborhoods: [], borough: null, minPrice: null, maxPrice: null, price: null,
    minBeds: null, maxBeds: null, beds: null, mustHaves: null, dealbreakers: null, timeline: null, propertyTypes: [],
  })
  const r = await criteriaSection(mockCtx(bare))
  assert.ok(r.content.prose?.includes('not on file'), 'location falls back to not on file')
  assert.ok(r.content.prose?.includes('any beds'), 'no bed constraint reads as any beds')
  // No fabricated must-haves / timeline sentence when those fields are null.
  assert.ok(!/Must-haves:/.test(r.content.prose ?? ''), 'no must-haves line when null')
})

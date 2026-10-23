import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFakePrisma, contact, ORG, ORG_ROW } from '../../__tests__/pr5FakePrisma'

// Brief 43 PR 5: search_parties no longer lists or searches CRM sellers
// (D11 [Ryan, 2026-10-18]; Q5, N2). CRM-stored buyers and renters (intent
// BUYER/RENTER) are buyers and renters, never sellers, with budget, beds and the
// test label (Q8). Pure: fake Prisma that evaluates every where clause.
let k = 0
const iso = (over: Record<string, unknown> = {}) => ({
  id: `iso_${++k}`, organizationId: ORG, category: 'BUYER_ISO', isDuplicate: false, processingStatus: 'active', provenance: null,
  extractedTitle: `Probe buyer ISO ${k}`, neighborhood: 'Bedford-Stuyvesant', neighborhoods: ['Bedford-Stuyvesant'], borough: 'Brooklyn',
  beds: null, minBeds: 3, maxBeds: 4, minPrice: 1_000_000, maxPrice: 2_000_000, isTestData: true, createdAt: new Date(Date.UTC(2026, 8, 1, 0, k)),
  ...over,
})
const seller = contact({ id: 'mc_seller', fullName: 'Probe Seller Pat' })
const crmBuyer = contact({
  id: 'mc_buyer', fullName: '[TEST_10] Probe Buyer', intent: 'BUYER', isTestData: true, phone: '7185550150',
  budgetMin: 1_500_000, budgetMax: 2_000_000, bedsMin: 3, bedsMax: 4, metadata: { seedBrief: '10.0' }, address: null,
})
const crmRenter = contact({
  id: 'mc_renter', fullName: 'Probe Renter', intent: 'RENTER', isTestData: false, budgetMin: 3_000, budgetMax: 4_000,
  bedsMin: 2, bedsMax: 2, metadata: { source: 'crm', crmLeadId: 'lead_r' },
})
const fake = makeFakePrisma({
  organization: [ORG_ROW],
  extractedOpportunity: [iso(), iso({ category: 'RENTER_INQUIRY', minPrice: 3_000, maxPrice: 4_000, minBeds: 2, maxBeds: 2 })],
  mojoContact: [seller, crmBuyer, crmRenter, contact({ fullName: 'Probe Seller Two', neighborhood: 'Bushwick' })],
})
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

const load = () => import('../searchParties')
const SELLER_IDS = new Set((fake.tables.mojoContact).filter(r => r.intent === 'SELLER').map(r => r.id))

test('no role: buyers and renters only, never a CRM seller', async () => {
  const { searchParties } = await load()
  const r = await searchParties({ neighborhoods: ['Bed-Stuy'] })
  assert.ok(r.cards.length > 0)
  for (const c of r.cards) {
    assert.ok(!SELLER_IDS.has(c.id), `CRM seller ${c.id} listed`)
    assert.ok(c.role === 'buyer' || c.role === 'renter')
    assert.notEqual(c.category, 'MOJO_LEAD')
  }
  assert.ok(r.cards.some(c => c.id === 'mc_buyer'), 'the CRM buyer is a buyer')
  assert.ok(r.cards.some(c => c.id === 'mc_renter'), 'the CRM renter is a renter')
})

test("role seller or landlord: nothing listed, and a plain note to name one instead", async () => {
  const { searchParties } = await load()
  for (const role of ['seller', 'landlord'] as const) {
    const r = await searchParties({ role, neighborhoods: ['Bed-Stuy'] })
    assert.deepEqual(r.cards, [])
    assert.equal(r.totalMatched, 0)
    assert.equal(r.note, "Sellers aren't searchable in chat; name one to look them up.")
  }
  assert.equal(fake.calls.some(c => c.model === 'mojoContact' && JSON.stringify(c.args?.where ?? {}).includes('SELLER')), false)
})

test("role buyer: the CRM buyer comes back as a buyer with budget, beds and the test label; renters don't", async () => {
  const { searchParties } = await load()
  const r = await searchParties({ role: 'buyer' })
  const card = r.cards.find(c => c.id === 'mc_buyer')
  assert.ok(card)
  assert.equal(card.role, 'buyer')
  assert.deepEqual(card.priceRange, [1_500_000, 2_000_000])
  assert.match(card.title, /3 to 4 beds/)
  assert.equal(card.isTestData, true)
  assert.equal(card.phone, null)
  assert.ok(!r.cards.some(c => c.id === 'mc_renter'))
  assert.ok(!r.cards.some(c => SELLER_IDS.has(c.id)))
})

test('role renter: the CRM renter; real data only drops the test buyer', async () => {
  const { searchParties } = await load()
  const r = await searchParties({ role: 'renter' })
  assert.ok(r.cards.some(c => c.id === 'mc_renter' && c.role === 'renter' && c.isTestData === false))
  assert.ok(!r.cards.some(c => c.id === 'mc_buyer'))
  const real = await searchParties({ includeTestData: false })
  assert.ok(!real.cards.some(c => c.id === 'mc_buyer'))
  assert.ok(real.cards.some(c => c.id === 'mc_renter'))
})

test('CRM buyers follow the beds and budget filters', async () => {
  const { searchParties } = await load()
  assert.ok(!(await searchParties({ role: 'buyer', bedsMin: 5 })).cards.some(c => c.id === 'mc_buyer'))
  assert.ok((await searchParties({ role: 'buyer', bedsMin: 4 })).cards.some(c => c.id === 'mc_buyer'))
  assert.ok(!(await searchParties({ role: 'buyer', priceRangeOverlaps: { min: 5_000_000, max: 6_000_000 } })).cards.some(c => c.id === 'mc_buyer'))
})

test("the tool description says nothing about sellers, Mojo, names or phones; the role list is buyers and renters", async () => {
  const { SEARCH_PARTIES_TOOL } = await import('../schemas')
  const text = JSON.stringify(SEARCH_PARTIES_TOOL)
  assert.ok(!/mojo/i.test(text), 'no "Mojo"')
  assert.ok(!/name \+ phone/i.test(text))
  assert.ok(!/seller|landlord/i.test(SEARCH_PARTIES_TOOL.description ?? ''))
  const role = (SEARCH_PARTIES_TOOL.input_schema as { properties: { role: { enum: string[] } } }).properties.role
  assert.deepEqual(role.enum, ['buyer', 'renter'])
})

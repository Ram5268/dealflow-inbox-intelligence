// Brief 43 PR 9 (Q15, Q41; TEST_PLAN B-06, T-07, B-08): search_parties finds a
// buyer by name or description, and by buyer type, and an unknown name finds
// nothing. Fake Prisma (pr9FakeDb), no database, no network. Every name, agent
// and request here is fictional.
import { pr9FakeDb, type Row } from './pr9FakeDb'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const ORG = 'org_pr9'
const fake = pr9FakeDb()
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

const day = (n: number) => new Date(Date.UTC(2026, 9, 19) - n * 86_400_000)
let k = 0
const iso = (over: Row): Row => ({
  id: `iso_${++k}`, organizationId: ORG, category: 'BUYER_ISO', isDuplicate: false, processingStatus: 'active',
  provenance: null, extractedTitle: `Buyer request ${k}`, extractedSummary: 'Looking for a home.',
  sourceAgentName: null, buyerArchetype: null, neighborhood: 'Bushwick', neighborhoods: ['Bushwick'], borough: 'Brooklyn',
  beds: null, minBeds: 2, maxBeds: 3, minPrice: 1_000_000, maxPrice: 2_000_000, isTestData: true, createdAt: day(k), ...over,
})

const JORDAN = iso({ extractedTitle: 'Jordan Sample: 3-family in Bed-Stuy', sourceAgentName: 'Casey Placeholder', isTestData: false })
const KITCHEN = iso({ extractedTitle: 'Condo with a big kitchen in Park Slope', sourceAgentName: 'Morgan Fictional' })
const STORED_1031 = iso({ extractedTitle: '[TEST_10] EXCHANGE_1031 — Chelsea', buyerArchetype: 'EXCHANGE_1031' })
const MENTIONS_1031 = iso({ extractedTitle: 'Two-family in Ridgewood', extractedSummary: 'A 1031 exchange buyer; must close by Dec 1.', isTestData: false })
const CASH_MENTIONS_1031 = iso({ extractedTitle: 'Cash buyer for Astoria', extractedSummary: 'Not a 1031, all cash.', buyerArchetype: 'CASH_BUYER' })
const NOT_1031 = iso({ extractedTitle: 'Townhouse buyer, Fort Greene', extractedSummary: 'Unit 10310 at the old address.' })
const RENTER = iso({ category: 'RENTER_INQUIRY', extractedTitle: 'Jordan Sample renter, 2 beds in Astoria', minPrice: 3_000, maxPrice: 4_000 })
const SELLER_SAME_NAME = { id: 'mojo_pr9', organizationId: ORG, fullName: 'Jordan Sample', phone: '7185550142', neighborhood: 'Bushwick', city: 'Brooklyn', address: '88 Example Ave', updatedAt: day(1) }

function load(extra: Row[] = []) {
  fake.data.organization = [{ id: ORG, slug: 'dealflow-ryan' }]
  fake.data.extractedOpportunity = [JORDAN, KITCHEN, STORED_1031, MENTIONS_1031, CASH_MENTIONS_1031, NOT_1031, RENTER, ...extra]
  fake.data.mojoContact = [SELLER_SAME_NAME]
  fake.calls.length = 0
}
const run = async (input: Record<string, unknown>) => {
  const { searchParties } = await import('../searchParties')
  return searchParties(input as never)
}
const ids = (r: { cards: Array<{ id: string }> }) => r.cards.map(c => c.id).sort()

test('an unknown name gives no results (B-06, T-07)', async () => {
  load()
  for (const query of ['Zorblax Quentin', 'Quentin']) {
    const r = await run({ query })
    assert.equal(r.cards.length, 0, query)
    assert.equal(r.totalMatched, 0, query)
  }
  // Part of a word is not a name: "Chen" is not in "kitchen".
  assert.equal((await run({ query: 'Chen' })).cards.length, 0)
  // Only filler words is no search, not every buyer.
  assert.equal((await run({ query: 'the buyer' })).cards.length, 0)
})

test("a name finds that buyer: in the request's title, or the agent's name", async () => {
  load()
  assert.deepEqual(ids(await run({ role: 'buyer', query: 'Jordan Sample' })), [JORDAN.id])
  assert.deepEqual(ids(await run({ role: 'buyer', query: 'sample, JORDAN' })), [JORDAN.id], 'any case, any order')
  const byAgent = await run({ query: 'Casey Placeholder' })
  assert.deepEqual(ids(byAgent), [JORDAN.id])
  assert.equal(byAgent.cards[0].agentName, 'Casey Placeholder', "the agent's name is on the card")
  // Words from the request work as a description.
  assert.deepEqual(ids(await run({ query: 'Ridgewood two-family' })), [MENTIONS_1031.id])
})

test('a name search covers renters, follows the role, and never returns a CRM seller (D11)', async () => {
  load()
  assert.deepEqual(ids(await run({ query: 'Jordan Sample' })), [JORDAN.id, RENTER.id].sort())
  assert.deepEqual(ids(await run({ role: 'renter', query: 'Jordan Sample' })), [RENTER.id])
  const r = await run({ query: 'Jordan Sample' })
  assert.ok(r.cards.every(c => c.role === 'buyer' || c.role === 'renter'))
  assert.ok(!JSON.stringify(r).includes('555'), 'no seller phone')
})

test('the name filter runs in the database, so a buyer older than the newest 500 is found (T-07)', async () => {
  const OLDEST = iso({ extractedTitle: 'Riley Example, brownstone buyer', createdAt: day(900) })
  const filler = Array.from({ length: 600 }, (_, i) => iso({ extractedTitle: `Buyer request filler ${i}`, createdAt: day(-i - 1) }))
  load([...filler, OLDEST])
  assert.deepEqual(ids(await run({ query: 'Riley Example' })), [OLDEST.id])
  const q = fake.calls.find(c => c.model === 'extractedOpportunity' && c.op === 'findMany')
  assert.match(JSON.stringify(q?.args.where), /"contains":"riley"/)
})

test('archetype finds 1031-exchange buyers: stored, or mentioned when none is stored (B-08, Q41)', async () => {
  load()
  const r = await run({ archetype: 'EXCHANGE_1031' })
  assert.deepEqual(ids(r), [STORED_1031.id, MENTIONS_1031.id].sort())
  // A stored type wins over a mention; "10310" is not "1031".
  assert.ok(!ids(r).includes(String(CASH_MENTIONS_1031.id)))
  assert.ok(!ids(r).includes(String(NOT_1031.id)))
  for (const c of r.cards) assert.equal(c.archetype, '1031 exchange')
  const cash = await run({ archetype: 'CASH_BUYER' })
  assert.deepEqual(ids(cash), [CASH_MENTIONS_1031.id])
  // Combined with a name or description.
  assert.deepEqual(ids(await run({ archetype: 'EXCHANGE_1031', query: 'Ridgewood' })), [MENTIONS_1031.id])
})

test('the archetype is on every buyer card, in plain words (Q41)', async () => {
  load()
  const r = await run({ role: 'buyer' })
  const card = (id: unknown) => r.cards.find(c => c.id === id)!
  assert.equal(card(STORED_1031.id).archetype, '1031 exchange')
  assert.equal(card(CASH_MENTIONS_1031.id).archetype, 'all cash')
  assert.equal(card(JORDAN.id).archetype, null)
  // Without the filter, nothing changes for a plain search: every buyer, no seller dropped by it.
  assert.equal(r.cards.filter(c => c.role === 'buyer').length, 6)
})

// Reviewer (Brief 43 PR 9 r1): how Ryan and Drift actually name a buyer.
test("a possessive, a number word or 'lead' still find the buyer; a blank query is no query", async () => {
  load()
  assert.deepEqual(ids(await run({ query: "Jordan Sample's" })), [JORDAN.id, RENTER.id].sort())
  assert.deepEqual(ids(await run({ query: 'Casey Placeholder\u2019s buyer' })), [JORDAN.id])
  assert.deepEqual(ids(await run({ query: "Jordan Sample's search" })), [JORDAN.id, RENTER.id].sort())
  assert.deepEqual(ids(await run({ role: 'buyer', query: 'Jordan lead' })), [JORDAN.id])
  // "three-family" is the title's "3-family", and the database narrowing allows both forms.
  assert.deepEqual(ids(await run({ query: 'Bed-Stuy three-family' })), [JORDAN.id])
  const where = JSON.stringify(fake.calls.filter(c => c.model === 'extractedOpportunity').at(-1)?.args.where)
  assert.match(where, /"contains":"3"/)
  assert.match(where, /"contains":"three"/)
  assert.deepEqual(ids(await run({ query: 'Ridgewood 2-family' })), [MENTIONS_1031.id])
  for (const query of ['', '   ']) assert.equal((await run({ role: 'buyer', query })).cards.length, 6, `blank query ${JSON.stringify(query)}`)
  // Still exact: a different name, part of a word, or filler only finds nothing.
  assert.equal((await run({ query: "Riley's" })).cards.length, 0)
  assert.equal((await run({ query: 'Chen' })).cards.length, 0)
  assert.equal((await run({ query: 'the lead' })).cards.length, 0)
})

// Review r1: a query is capped at 8 distinct words, so the database query stays small.
test('a long query counts only its first 8 distinct words', async () => {
  const { queryWords, MAX_QUERY_WORDS } = await import('../partyFilters')
  assert.equal(MAX_QUERY_WORDS, 8)
  assert.deepEqual(queryWords('Jordan jordan SAMPLE'), ['jordan', 'sample'])
  const long = Array.from({ length: 20 }, (_, i) => `word${String.fromCharCode(97 + i)}`).join(' ')
  assert.equal(queryWords(long).length, 8)
  load()
  await run({ query: long })
  const where = JSON.stringify(fake.calls.filter(c => c.model === 'extractedOpportunity').at(-1)?.args.where)
  // 8 words in each of the two fields (title, agent).
  assert.equal(where.match(/"contains"/g)?.length, 16)
})

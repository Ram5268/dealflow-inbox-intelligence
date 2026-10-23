// Brief 48 (PR 15, item 4.13): re-reading an email replaces its listings, and the
// Match rows that pointed at the old listings go with them. Brief 32 dropped the
// Match → listing foreign key (a match's supply can be a CRM contact), so nothing
// cascades, and every replace left "orphaned" matches behind: on /matches, in the
// counts, and on the CRM's seller cards (Brief 40 audit D4-18). This covers the shared
// helper, the V2 re-extract (extractEmailV2) and the buried-lead re-run. The
// reextract and reclassify routes are in app/api/sync/__tests__/reextractMatches.unit.test.ts.
// No database and no network: Prisma is an in-memory stand-in, the AI SDKs get a
// stand-in for fetch, and the embedding and NYC lookups are stubbed. Every row is invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { installFakeAiFetch, anthropicTool } from '../../__tests__/fakeAiFetch'
import { listingDb, type Row } from './listingDb'

const ai = installFakeAiFetch()

// The embedding and NYC enrichment steps run after the swap and are non-fatal;
// stubbed so they make no calls.
const stub = (rel: string, exports: Record<string, unknown>) => {
  const p = require.resolve(join(__dirname, '..', '..', rel))
  require.cache[p] = { id: p, filename: p, loaded: true, exports } as unknown as NodeJS.Module
}
stub('embeddings', { buildOpportunityText: () => 'text', upsertOpportunityEmbedding: async () => {} })
stub(join('enrichment', 'nyc'), { resolvePropertyType: async () => { throw new Error('stubbed: no NYC lookups in this test') } })

let db = listingDb({})
;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy({}, { get: (_t, prop) => (db.client as Record<string | symbol, unknown>)[prop] })

const ORG = 'org-test'
const at = new Date('2026-10-20T12:00:00Z')
const chunk = (parentEmailId: string, content: string): Row => ({
  organizationId: ORG, parentEmailId, chunkType: 'email_body', content, pageNumber: null, sectionHeading: null,
  hasTable: false, parentAttachmentId: null, parentLinkedResourceId: null, createdAt: at,
})
const listing = (id: string, rawEmailId: string, over: Row = {}): Row => ({
  id, organizationId: ORG, rawEmailId, category: 'SELLER_LEAD', provenance: null, processingStatus: 'active', createdAt: at, ...over,
})
const match = (id: string, over: Row): Row => ({
  id, organizationId: ORG, opportunityType: 'opportunity', score: 80, createdAt: at, ...over,
})

// Email raw-1 holds listings L1 and L2; K1 is another email's buyer request.
function seed() {
  db = listingDb({
    organization: [{ id: ORG, slug: 'dealflow-ryan' }],
    rawEmail: [
      { id: 'raw-1', subject: 'Two homes', senderName: 'Referring Agent', senderEmail: 'agent@example.com', receivedDateTime: at, classifierCategory: 'SELLER_LEAD' },
      { id: 'raw-3', subject: 'Catching up', senderName: 'Referring Agent', senderEmail: 'agent@example.com', receivedDateTime: at, classifierCategory: 'CLIENT_CONVERSATION' },
    ],
    documentChunk: [
      chunk('raw-1', 'The owner of 12 Example St wants to sell in the spring.'),
      chunk('raw-3', 'Good to see you. The owner of 12 Sample St may sell next year.'),
    ],
    linkedResource: [],
    attachment: [],
    extractedOpportunity: [
      listing('L1', 'raw-1'),
      listing('L2', 'raw-1', { category: 'OFF_MARKET_SALE' }),
      listing('K1', 'raw-2', { category: 'BUYER_ISO' }),
      listing('R1', 'raw-3', { provenance: 'buried_recovery' }),
      listing('R2', 'raw-3', { provenance: null, category: 'CLIENT_CONVERSATION' }),
    ],
    match: [
      match('m-supply', { opportunityId: 'L1', counterpartType: 'opportunity', counterpartId: 'K1' }), // L1 is the listing
      match('m-demand', { opportunityId: 'K1', counterpartType: 'opportunity', counterpartId: 'L2' }), // L2 is the counterpart
      match('m-showing', { opportunityId: 'L1', counterpartType: 'showing_confirmation', counterpartId: 'L1' }),
      match('m-contact', { opportunityType: 'contact', opportunityId: 'contact-1', counterpartType: 'opportunity', counterpartId: 'L1' }),
      match('m-other', { opportunityId: 'K1', counterpartType: 'mojo', counterpartId: 'contact-2' }), // not about L1/L2
      match('m-crm', { opportunityType: 'contact', opportunityId: 'L2', counterpartType: 'mojo', counterpartId: 'contact-3' }), // a contact id, not a listing
      match('m-recovered', { opportunityId: 'R1', counterpartType: 'opportunity', counterpartId: 'K1' }),
      match('m-kept-email', { opportunityId: 'R2', counterpartType: 'opportunity', counterpartId: 'K1' }),
    ],
    reviewQueueItem: [],
    aIExtractionLog: [],
  })
}
const matchIds = () => db.rows('match').map(m => m.id).sort()

test('matchesOfListings: the Match rows that point at the listings, on either side, and no others', async () => {
  seed()
  const { matchesOfListings } = await import('../listingMatches')
  const hit = (await db.client.match as { findMany: (a: Row) => Promise<Row[]> }).findMany({ where: matchesOfListings(['L1', 'L2']) })
  assert.deepEqual((await hit).map(m => m.id).sort(), ['m-contact', 'm-demand', 'm-showing', 'm-supply'])
})

test('deleteListingsAndMatches: deletes the listings and their matches, nothing else', async () => {
  seed()
  const { deleteListingsAndMatches } = await import('../listingMatches')
  const out = await deleteListingsAndMatches(db.client as never, { rawEmailId: 'raw-1' })
  assert.deepEqual(out, { listings: 2, matches: 4 })
  assert.deepEqual(db.rows('extractedOpportunity').map(r => r.id).sort(), ['K1', 'R1', 'R2'])
  assert.deepEqual(matchIds(), ['m-crm', 'm-kept-email', 'm-other', 'm-recovered'])
  // No listing selected: nothing is deleted.
  const calls = db.calls.length
  assert.deepEqual(await deleteListingsAndMatches(db.client as never, { rawEmailId: 'raw-none' }), { listings: 0, matches: 0 })
  assert.ok(db.calls.slice(calls).every(c => c.op !== 'deleteMany'))
})

test("re-extracting an email (V2) deletes the old listings' matches in the same transaction", async () => {
  seed()
  ai.reply(() => anthropicTool('extract_seller_lead', { leads: [{
    address: '12 Example St', neighborhood: 'Park Slope', borough: 'Brooklyn', city: 'Brooklyn', state: 'NY', zip: '11215',
    price: null, beds: 3, baths: 2, squareFeet: null, units: 1, propertyType: 'townhouse', availabilityDate: null, status: null,
    sourceAgentName: 'Referring Agent', sourceAgentEmail: 'agent@example.com', sourceBrokerage: null, motivation: null,
    extractedTitle: 'Seller lead: Park Slope townhouse', extractedSummary: 'The owner wants to sell in the spring.',
    classificationReason: 'Seller lead.', confidenceScore: 0.9,
  }] }))
  const { extractEmailV2 } = await import('../extractEmailV2')
  const created = await extractEmailV2('raw-1', ORG)
  assert.equal(created.length, 1)
  const left = db.rows('extractedOpportunity').map(r => r.id)
  assert.ok(!left.includes('L1') && !left.includes('L2'), 'the old listings are replaced')
  assert.deepEqual(matchIds(), ['m-crm', 'm-kept-email', 'm-other', 'm-recovered'], 'no match points at L1 or L2 any more')
  const del = db.calls.find(c => c.model === 'match' && c.op === 'deleteMany')
  assert.ok(del?.inTx, 'the matches go in the transaction that replaces the listings')
})

test('the buried-lead re-run deletes the matches of the recovered rows it replaces', async () => {
  seed()
  ai.reply(() => anthropicTool('report_buried_lead', {
    found: true, category: 'SELLER_LEAD', clientSide: 'seller', neighborhood: 'Park Slope', borough: 'Brooklyn', address: null,
    price: null, beds: null, isHistoricalComp: false, confidence: 0.85, summary: 'An owner may sell next year', reason: 'The sender says so.',
  }))
  const { recoverAndPersistBuriedLead } = await import('../extractEmailV2')
  assert.ok(await recoverAndPersistBuriedLead('raw-3', ORG))
  const left = db.rows('extractedOpportunity').map(r => r.id)
  assert.ok(!left.includes('R1'), 'the old recovered row is replaced')
  assert.ok(left.includes('R2'), "the email's other rows stay")
  assert.ok(!matchIds().includes('m-recovered'), "the replaced row's match is gone")
  assert.ok(matchIds().includes('m-kept-email'), "the email's other rows keep their matches")
  assert.ok(db.calls.find(c => c.model === 'match' && c.op === 'deleteMany')?.inTx, 'in one transaction')
})

// Brief 48 (PR 15, item 4.13): the two maintenance routes that replace or delete an
// email's listings also delete the Match rows that pointed at them (Brief 40 audit
// D4-18: the Match → listing foreign key is gone since Brief 32, so nothing cascades).
// - POST /api/sync/reextract: the old listings' matches go in the same transaction
//   that swaps the listings.
// - POST /api/sync/reclassify: a listing re-read as noise is deleted with its matches.
// Runs the real routes under tsx with the maintenance switch on in this process only,
// the AI extractor and embeddings stubbed, and an in-memory stand-in for Prisma. No
// database and no network. Every row is invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { listingDb, type Row } from '../../../../lib/extraction/__tests__/listingDb'

process.env.MAINTENANCE_ENABLED = 'true'
globalThis.fetch = (async () => { throw new Error('no network in this test') }) as typeof fetch

let answer: unknown[] = []
const stub = (rel: string, exports: Record<string, unknown>) => {
  const p = require.resolve(join(__dirname, '..', '..', '..', '..', 'lib', rel))
  require.cache[p] = { id: p, filename: p, loaded: true, exports } as unknown as NodeJS.Module
}
stub('ai', { classifyAndExtractEmail: async () => answer })
stub('embeddings', { buildOpportunityText: () => 'text', upsertOpportunityEmbedding: async () => {} })

let db = listingDb({})
;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy({}, { get: (_t, prop) => (db.client as Record<string | symbol, unknown>)[prop] })

const ORG = 'org-test'
const at = new Date('2026-10-20T12:00:00Z')
const email: Row = {
  id: 'raw-1', graphMessageId: 'msg-1', subject: 'Two homes', senderName: 'Referring Agent', senderEmail: 'agent@example.com',
  receivedDateTime: at, bodyPreview: 'Two homes', bodyContent: 'Two homes for sale.', attachmentsText: null,
}
const listing = (id: string, rawEmailId: string, over: Row = {}): Row => ({
  id, organizationId: ORG, rawEmailId, category: 'ACTIVE_SALE_LISTING', transactionType: 'SALE', processingStatus: 'active',
  classificationReason: 'old reason', extractedTitle: `Listing ${id}`, createdAt: at, ...over,
})
const match = (id: string, over: Row): Row => ({ id, organizationId: ORG, opportunityType: 'opportunity', score: 80, createdAt: at, ...over })
function seed() {
  db = listingDb({
    organization: [{ id: ORG, slug: 'dealflow-ryan' }],
    rawEmail: [email],
    extractedOpportunity: [
      listing('L1', 'raw-1', { rawEmail: email }),
      listing('L2', 'raw-1', { rawEmail: email }),
      listing('K1', 'raw-2', { category: 'BUYER_ISO', classificationReason: 'SENDER ROLE: buyer agent', rawEmail: { graphMessageId: 'msg-2' } }),
    ],
    match: [
      match('m-supply', { opportunityId: 'L1', counterpartType: 'opportunity', counterpartId: 'K1' }),
      match('m-demand', { opportunityId: 'K1', counterpartType: 'opportunity', counterpartId: 'L2' }),
      match('m-contact', { opportunityType: 'contact', opportunityId: 'contact-1', counterpartType: 'opportunity', counterpartId: 'L1' }),
      match('m-other', { opportunityId: 'K1', counterpartType: 'mojo', counterpartId: 'contact-2' }),
    ],
  })
}
const matchIds = () => db.rows('match').map(m => m.id).sort()
const post = (path: string, body: unknown) =>
  new NextRequest(`https://dealflow.example${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { log, error } = console
  console.log = () => {}; console.error = () => {}
  try { return await fn() } finally { console.log = log; console.error = error }
}

const entry = (over: Row = {}): Row => ({
  isRelevant: true, category: 'ACTIVE_SALE_LISTING', transactionType: 'SALE', propertyType: 'townhouse', address: '12 Example St',
  neighborhood: 'Park Slope', borough: 'Brooklyn', city: 'Brooklyn', state: 'NY', zip: null, price: 1_900_000, minPrice: null, maxPrice: null,
  beds: 3, baths: 2, units: 1, squareFeet: null, availabilityDate: null, sourceAgentName: 'Referring Agent', sourceAgentEmail: 'agent@example.com',
  sourceBrokerage: null, clientSide: null, status: null, extractedTitle: 'Park Slope townhouse', extractedSummary: 'For sale.',
  classificationReason: 'SENDER ROLE: listing agent', confidenceScore: 0.9, ...over,
})

test("reextract: the old listings' matches are deleted in the swap transaction", async () => {
  seed()
  answer = [entry()]
  const { POST } = await import('../reextract/route')
  const res = await quiet(() => POST(post('/api/sync/reextract', { rawEmailId: 'raw-1' })))
  const body = await res.json() as Row
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.deepEqual([body.totalDeleted, body.totalCreated, body.failed], [2, 1, 0])
  const left = db.rows('extractedOpportunity').map(r => r.id)
  assert.ok(!left.includes('L1') && !left.includes('L2') && left.includes('K1'))
  assert.deepEqual(matchIds(), ['m-other'], 'no match points at L1 or L2 any more')
  assert.ok(db.calls.find(c => c.model === 'match' && c.op === 'deleteMany')?.inTx, 'deleted inside the swap transaction')
})

test('reextract: when the new answer has no listings, the old ones and their matches stay', async () => {
  seed()
  answer = [entry({ isRelevant: false, category: 'NOISE' })]
  const { POST } = await import('../reextract/route')
  const body = await (await quiet(() => POST(post('/api/sync/reextract', { rawEmailId: 'raw-1' })))).json() as Row
  assert.equal(body.skipped, 1)
  assert.deepEqual(matchIds(), ['m-contact', 'm-demand', 'm-other', 'm-supply'])
})

test('reclassify: a listing re-read as noise is deleted together with its matches', async () => {
  seed()
  // Only L1 waits for reclassifying: L2 and K1 already have the new prompt's SENDER ROLE.
  db.rows('extractedOpportunity')[1].classificationReason = 'SENDER ROLE: listing agent'
  answer = [entry({ isRelevant: false, category: 'NOISE' })]
  const { POST } = await import('../reclassify/route')
  const body = await (await quiet(() => POST(post('/api/sync/reclassify', { limit: 5 })))).json() as Row
  assert.deepEqual([body.total, body.reclassified, body.failed], [1, 1, 0], JSON.stringify(body))
  assert.ok(!db.rows('extractedOpportunity').some(r => r.id === 'L1'), 'L1 is deleted')
  assert.deepEqual(matchIds(), ['m-demand', 'm-other'], "L1's matches are gone; L2's (still saved) stay")
  assert.ok(db.calls.find(c => c.model === 'match' && c.op === 'deleteMany')?.inTx, 'in one transaction with the delete')
})

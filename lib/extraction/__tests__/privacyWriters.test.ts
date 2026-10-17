// Brief 41.1 (review F4) — the personal-circumstances filter also covers a
// client conversation with a seller or landlord, and a seller's or landlord's
// lead status. Pure: schemas.ts imports only zod, type-only SDK types and the
// pure helpers. The V1 and legacy extractors load the OpenAI and Anthropic
// SDKs, so their wiring is checked by their source (like
// personalCircumstances.test.ts) and the legacy logic through its pure helper.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXTRACTION_SPEC_BY_CATEGORY } from '../schemas'
import { conversationNeedsFilter, safeConversationText, safeStatus, withoutPersonalText } from '../personalCircumstances'

const ROOT = join(__dirname, '..', '..', '..')
const src = (f: string) => readFileSync(join(ROOT, f), 'utf8')
const ctx = { subject: 's', senderName: null, senderEmail: null }

const conversation = (over: Record<string, unknown>) => ({
  clientName: 'Jane Q Owner', clientEmail: null, agentName: 'Agent', agentEmail: null, brokerage: null, clientSide: 'seller',
  neighborhood: 'Park Slope', borough: 'Brooklyn', price: null, beds: null, propertyType: null, address: '12 Example St',
  keyTopics: null, nextStep: null, extractedTitle: 'Owner wants to list 12 Example St',
  extractedSummary: 'Owner wants to list the brownstone. Her husband passed in May and she is moving to assisted living.',
  classificationReason: 'Direct conversation with the owner.', confidenceScore: 0.9,
  ...over,
})
const v2Conversation = (over: Record<string, unknown>) => EXTRACTION_SPEC_BY_CATEGORY.CLIENT_CONVERSATION!.mapItem(conversation(over), ctx)

const lead = (over: Record<string, unknown>) => ({
  address: '12 Example St', neighborhood: 'Park Slope', borough: 'Brooklyn', city: null, state: null, zip: null,
  price: null, minPrice: null, maxPrice: null, beds: null, baths: null, squareFeet: null, units: null, propertyType: 'townhouse',
  availabilityDate: null, status: null, sourceAgentName: 'Agent', sourceAgentEmail: null, sourceBrokerage: null,
  motivation: null, leaseType: null, extractedTitle: 'Seller lead', extractedSummary: 'Owner wants to list.', classificationReason: 'x', confidenceScore: 0.9,
  ...over,
})

test('a seller or landlord conversation never stores their personal circumstances (V2)', () => {
  const seller = v2Conversation({ nextStep: 'Call her after the funeral' })
  assert.equal(seller.extractedSummary, 'Owner wants to list the brownstone.')
  assert.equal(seller.extractedTitle, 'Owner wants to list 12 Example St')
  const landlord = v2Conversation({
    clientSide: 'landlord', extractedTitle: 'Landlord going through a divorce', extractedSummary: 'Two units to rent. Divorce pending.',
    classificationReason: 'Landlord. Owner is divorcing.',
  })
  assert.equal(landlord.extractedTitle, 'Client conversation – 12 Example St')
  assert.equal(landlord.extractedSummary, 'Two units to rent.')
  assert.equal(landlord.classificationReason, 'Landlord.')
  // A side the model couldn't tell (or wrote its own way) is filtered too: fail closed.
  for (const side of ['unknown', null, 'Seller', 'owner']) {
    assert.equal(v2Conversation({ clientSide: side }).extractedSummary, 'Owner wants to list the brownstone.', String(side))
  }
})

test("a buyer's or renter's conversation keeps its needs (the filter is for sellers and landlords)", () => {
  const summary = 'Buyer wants a 3BR with an elevator for her elderly mother.'
  assert.equal(v2Conversation({ clientSide: 'buyer', extractedSummary: summary }).extractedSummary, summary)
  assert.equal(v2Conversation({ clientSide: 'Renter', extractedSummary: summary }).extractedSummary, summary)
  assert.deepEqual(['buyer', 'renter', 'seller', 'landlord', 'unknown', null].map(conversationNeedsFilter), [false, false, true, true, true, true])
})

test('both conversation prompts say never to record personal circumstances, and V1 and the legacy extractor filter too', () => {
  assert.match(EXTRACTION_SPEC_BY_CATEGORY.CLIENT_CONVERSATION!.systemPrompt, /Never record personal circumstances/)
  const v1 = src('lib/ingestion/extractors/clientConversationExtractor.ts')
  assert.match(v1, /Never record personal circumstances/)
  assert.match(v1, /safeConversationText\(\{/)
  assert.doesNotMatch(v1, /extractedSummary:\s*\[c\.extractedSummary/) // never the raw summary
  // Its schema-failure title (the email subject) is replaced if it mentions one.
  assert.match(v1, /input\.subject && !mentionsPersonalCircumstances\(input\.subject\)/)
  // The legacy extractor's results all go through the pure helper (tested below).
  assert.match(src('lib/ai.ts'), /export function withoutPersonalLeadText\(r: ExtractionResult\): ExtractionResult \{\s*return withoutPersonalText\(r\)\s*\}/)
  // The shared helper V1 uses
  const t = safeConversationText({
    clientSide: 'unknown', title: 'Estate sale – 12 Example St', summary: 'Owner is elderly. Wants to list in May.', reason: 'Conversation.',
    fallbackTitle: 'Client conversation – 12 Example St',
  })
  assert.deepEqual(t, { title: 'Client conversation – 12 Example St', summary: 'Wants to list in May.', reason: 'Conversation.' })
})

test("a seller's or landlord's status never keeps them (V1, V2 and the legacy extractor)", () => {
  const seller = (status: string | null) => EXTRACTION_SPEC_BY_CATEGORY.SELLER_LEAD!.mapItem(lead({ status }), ctx).status
  assert.equal(seller('Estate sale, probate pending'), null)
  assert.equal(seller('Ready to list; owner passed in March'), null) // a sensitive clause drops the whole sentence
  assert.equal(seller('Ready to list. Owner passed in March.'), 'Ready to list.')
  assert.equal(seller('Ready to list in spring'), 'Ready to list in spring')
  assert.equal(seller(null), null)
  const landlord = EXTRACTION_SPEC_BY_CATEGORY.LANDLORD_LEAD!.mapItem(lead({ status: 'Owner in hospice' }), ctx)
  assert.equal(landlord.status, null)
  assert.equal(safeStatus('Divorce pending'), null)
  assert.equal(safeStatus(''), '')
  for (const f of ['lib/ingestion/extractors/sellerLeadExtractor.ts', 'lib/ingestion/extractors/landlordLeadExtractor.ts']) {
    assert.match(src(f), /status:\s+safeStatus\(l\.status\)/, f)
  }
})

// What the legacy extractor (lib/ai.ts; saved by the Outlook sync, re-extract
// and reclassify) returns for a lead or a client conversation.
const legacy = (over: Record<string, unknown>) => ({
  category: 'CLIENT_CONVERSATION', clientSide: 'seller', status: null as string | null, address: '12 Example St', neighborhood: 'Park Slope',
  extractedTitle: 'Talk with owner about 12 Example St', extractedSummary: 'Owner wants to list in spring.',
  classificationReason: 'Two-way thread with the owner.', confidenceScore: 0.9,
  ...over,
})

test("the legacy extractor: a seller's conversation or lead keeps no personal circumstances, status included (PR G review)", () => {
  const conversation = withoutPersonalText(legacy({ status: 'Owner passed in March; heirs deciding whether to list' }))
  assert.equal(conversation.status, null)
  assert.equal(conversation.extractedSummary, 'Owner wants to list in spring.')
  assert.equal(withoutPersonalText(legacy({ clientSide: 'unknown', status: 'Divorce pending' })).status, null)
  const filtered = withoutPersonalText(legacy({ extractedTitle: 'Estate sale', extractedSummary: 'Probate. Wants to list in May.', status: 'Ready to list' }))
  assert.deepEqual([filtered.extractedTitle, filtered.extractedSummary, filtered.status], ['Client conversation – 12 Example St', 'Wants to list in May.', 'Ready to list'])
  const lead = withoutPersonalText(legacy({ category: 'SELLER_LEAD', clientSide: null, status: 'Owner in hospice', extractedTitle: 'Seller lead' }))
  assert.equal(lead.status, null)
  assert.equal(lead.confidenceScore, 0.9) // other fields come back as they were
  // A buyer's conversation and other categories are left as they were.
  const buyer = legacy({ clientSide: 'buyer', status: 'Mother is ill' })
  assert.equal(withoutPersonalText(buyer), buyer)
  const listing = legacy({ category: 'ACTIVE_SALE_LISTING', status: 'Estate sale' })
  assert.equal(withoutPersonalText(listing), listing)
})

test('a Jamaica Estates seller (V2): the place name never hides what comes before it (PR G review blocker)', () => {
  const row = EXTRACTION_SPEC_BY_CATEGORY.SELLER_LEAD!.mapItem(lead({
    neighborhood: 'Jamaica Estates', borough: 'Queens', status: 'Probate Jamaica Estates Sale Pending', motivation: 'Inherited Jamaica Estates Home',
    extractedTitle: 'Inherited Jamaica Estates Colonial', extractedSummary: 'Inherited Jamaica Estates colonial. Wants to list in May.',
    classificationReason: 'Probate Jamaica Estates Listing',
  }), ctx)
  assert.deepEqual(
    { title: row.extractedTitle, summary: row.extractedSummary, reason: row.classificationReason, status: row.status },
    { title: 'Seller lead – 12 Example St', summary: 'Wants to list in May.', reason: 'Classified from the email; personal details left out.', status: null },
  )
  // An ordinary Jamaica Estates seller keeps everything, motivation included.
  const ordinary = EXTRACTION_SPEC_BY_CATEGORY.SELLER_LEAD!.mapItem(lead({
    neighborhood: 'Jamaica Estates', status: 'Ready to list', motivation: 'relocating', extractedTitle: 'Jamaica Estates colonial',
    extractedSummary: 'Jamaica Estates colonial with a finished basement.', classificationReason: 'Seller lead in Jamaica Estates.',
  }), ctx)
  assert.deepEqual(
    { title: ordinary.extractedTitle, summary: ordinary.extractedSummary, reason: ordinary.classificationReason, status: ordinary.status },
    { title: 'Jamaica Estates colonial', summary: 'Jamaica Estates colonial with a finished basement. Motivation: relocating', reason: 'Seller lead in Jamaica Estates.', status: 'Ready to list' },
  )
})

// Brief 41.1 (review F4) — the personal-circumstances filter also covers a
// client conversation with a seller or landlord, and a seller's or landlord's
// lead status. Pure: schemas.ts imports only zod, type-only SDK types and the
// pure helpers; the V1 and legacy extractors (which load the OpenAI and
// Anthropic SDKs) are checked by their source, like personalCircumstances.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXTRACTION_SPEC_BY_CATEGORY } from '../schemas'
import { conversationNeedsFilter, safeConversationText, safeStatus } from '../personalCircumstances'

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
  const legacy = src('lib/ai.ts')
  assert.match(legacy, /r\.category === 'CLIENT_CONVERSATION'[\s\S]{0,80}safeConversationText\(/)
  // The shared helper V1 and the legacy extractor use
  const t = safeConversationText({
    clientSide: 'unknown', title: 'Estate sale – 12 Example St', summary: 'Owner is elderly. Wants to list in May.', reason: 'Conversation.',
    fallbackTitle: 'Client conversation – 12 Example St',
  })
  assert.deepEqual(t, { title: 'Client conversation – 12 Example St', summary: 'Wants to list in May.', reason: 'Conversation.' })
})

test("a seller's or landlord's status never keeps them (V1, V2 and the legacy extractor)", () => {
  const seller = (status: string | null) => EXTRACTION_SPEC_BY_CATEGORY.SELLER_LEAD!.mapItem(lead({ status }), ctx).status
  assert.equal(seller('Estate sale, probate pending'), null)
  assert.equal(seller('Ready to list; owner passed in March'), 'Ready to list')
  assert.equal(seller('Ready to list in spring'), 'Ready to list in spring')
  assert.equal(seller(null), null)
  const landlord = EXTRACTION_SPEC_BY_CATEGORY.LANDLORD_LEAD!.mapItem(lead({ status: 'Owner in hospice' }), ctx)
  assert.equal(landlord.status, null)
  assert.equal(safeStatus('Divorce pending'), null)
  assert.equal(safeStatus(''), '')
  for (const f of ['lib/ingestion/extractors/sellerLeadExtractor.ts', 'lib/ingestion/extractors/landlordLeadExtractor.ts']) {
    assert.match(src(f), /status:\s+safeStatus\(l\.status\)/, f)
  }
  assert.match(src('lib/ai.ts'), /status: typeof r\.status === 'string' \? safeStatus\(r\.status\) : r\.status/)
})

// Ryan's decision, 2026-10-17: saved seller notes may keep these details.
// Buyer-facing text still never names motivation (engineering precaution,
// Brief 41 H7).
//
// This file pins the first half on every save path: a seller or landlord lead,
// a client conversation with a seller, and their status keep estate, probate,
// divorce and similar details as the model returned them (V2 Sonnet, the V1
// OpenAI extractors, the legacy lib/ai.ts extractor that the Outlook sync,
// re-extract and reclassify save, and the buried-lead second pass).
// ownerNotesBuyerFacing.test.ts pins the second half. No database and no
// network: the AI SDKs get a stand-in for fetch, Prisma a stand-in object.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installFakeAiFetch, openAiChat, anthropicText, anthropicTool, systemPromptOf } from '../../__tests__/fakeAiFetch'
import { EXTRACTION_SPEC_BY_CATEGORY } from '../schemas'
import type { ExtractorInput } from '../../ingestion/types'
import extractSellerV1 from '../../ingestion/extractors/sellerLeadExtractor'
import extractLandlordV1 from '../../ingestion/extractors/landlordLeadExtractor'
import extractConversationV1 from '../../ingestion/extractors/clientConversationExtractor'
import { classifyAndExtractEmail } from '../../ai'

const ai = installFakeAiFetch()
// extractEmailV2 is imported after this, so it binds to the stand-in.
const db: Record<string, unknown> = {}
;(globalThis as unknown as { prisma: unknown }).prisma = db
const v2 = () => import('../extractEmailV2')

const ESTATE = 'Estate sale, the executor is handling it'
const MOTIVATION_LINE = "motivation: brief note on why they're selling if mentioned (estate, divorce, relocation, downsizing, etc.)"
const OLD_FILTER_LINE = /Never record personal circumstances/

// What the model returns for a seller lead (V2 tool input and V1 JSON alike).
const seller = {
  address: '12 Example St', neighborhood: 'Park Slope', borough: 'Brooklyn', city: 'Brooklyn', state: 'NY', zip: '11215',
  price: null, beds: 4, baths: 2, squareFeet: 2400, units: 1, propertyType: 'townhouse', availabilityDate: null,
  status: 'Estate sale; the executor is handling it', sourceAgentName: 'Referring Agent', sourceAgentEmail: 'agent@example.com',
  sourceBrokerage: null, motivation: ESTATE,
  extractedTitle: 'Estate sale: Park Slope townhouse',
  extractedSummary: 'Owner wants to list the townhouse in the spring. Estate sale, the executor is handling it.',
  classificationReason: 'Seller lead: an estate sale the executor is handling.',
  confidenceScore: 0.9,
}
const landlord = {
  address: null, neighborhood: 'Bushwick', borough: 'Brooklyn', city: 'Brooklyn', state: 'NY', zip: null,
  price: 3200, minPrice: null, maxPrice: null, beds: 2, baths: 1, squareFeet: null, units: 2, propertyType: 'multi-family',
  availabilityDate: '2026-12-01', status: 'Divorce pending; the owners want a tenant in place',
  sourceAgentName: 'Referring Agent', sourceAgentEmail: 'agent@example.com', sourceBrokerage: null, leaseType: '12-month',
  extractedTitle: 'Landlord lead: owners divorcing, 2BR in Bushwick',
  extractedSummary: 'Two-family. The owners are going through a divorce and want the top unit rented.',
  classificationReason: 'Landlord lead: the owners are divorcing and want representation.',
  confidenceScore: 0.85,
}
const conversation = {
  clientName: null, clientEmail: null, agentName: 'Referring Agent', agentEmail: 'agent@example.com', brokerage: null,
  clientSide: 'seller', neighborhood: 'Park Slope', borough: 'Brooklyn', price: null, beds: 4, propertyType: 'townhouse',
  address: '12 Example St', keyTopics: 'probate timing; listing in the spring', nextStep: 'Call the executor once probate closes',
  extractedTitle: 'Probate: seller of 12 Example St',
  extractedSummary: 'The seller will list once probate closes.',
  classificationReason: 'Two-way thread with the seller about probate.',
  confidenceScore: 0.9,
}
const SELLER_SUMMARY = `${seller.extractedSummary} Motivation: ${ESTATE}`
const LANDLORD_SUMMARY = `${landlord.extractedSummary} Lease: 12-month`
const CONVERSATION_SUMMARY = `${conversation.extractedSummary} Next: ${conversation.nextStep}`

const ctx = { subject: 'Estate sale at 12 Example St', senderName: 'Referring Agent', senderEmail: 'agent@example.com' }
const lastPrompt = () => systemPromptOf(ai.requests[ai.requests.length - 1])

test('V2: a seller lead keeps the estate sale in its motivation, summary, title, reason and status', async () => {
  const { runExtraction } = await v2()
  ai.reply(() => anthropicTool('extract_seller_lead', { leads: [seller] }))
  const { rows, error } = await runExtraction(EXTRACTION_SPEC_BY_CATEGORY.SELLER_LEAD!, 'Subject: Estate sale', ctx)
  assert.equal(error, null)
  assert.equal(rows[0].extractedSummary, SELLER_SUMMARY)
  assert.equal(rows[0].extractedTitle, seller.extractedTitle)
  assert.equal(rows[0].classificationReason, seller.classificationReason)
  assert.equal(rows[0].status, seller.status)
  // The prompt asks for the motivation again (as before Brief 41) and no longer says to leave these details out.
  assert.ok(lastPrompt().includes(MOTIVATION_LINE))
  assert.doesNotMatch(lastPrompt(), OLD_FILTER_LINE)
})

test('V2: a landlord lead keeps the divorce; a seller-side client conversation keeps the probate', async () => {
  const { runExtraction } = await v2()
  ai.reply(() => anthropicTool('extract_landlord_lead', { leads: [landlord] }))
  const l = (await runExtraction(EXTRACTION_SPEC_BY_CATEGORY.LANDLORD_LEAD!, 'Subject: Rental', ctx)).rows[0]
  assert.deepEqual([l.extractedTitle, l.extractedSummary, l.classificationReason, l.status],
    [landlord.extractedTitle, LANDLORD_SUMMARY, landlord.classificationReason, landlord.status])

  ai.reply(() => anthropicTool('extract_client_conversation', { conversations: [conversation] }))
  const c = (await runExtraction(EXTRACTION_SPEC_BY_CATEGORY.CLIENT_CONVERSATION!, 'Subject: Probate', ctx)).rows[0]
  assert.deepEqual([c.clientSide, c.extractedTitle, c.extractedSummary, c.classificationReason],
    ['seller', conversation.extractedTitle, CONVERSATION_SUMMARY, conversation.classificationReason])
  assert.doesNotMatch(lastPrompt(), OLD_FILTER_LINE)
})

const input = (subject: string): ExtractorInput => ({
  rawEmailId: 'raw-test', subject, senderName: 'Referring Agent', senderEmail: 'agent@example.com',
  bodyPreview: 'Estate sale, the executor is handling it.', bodyFirst500: null,
  attachmentNames: [], attachmentMimeTypes: [], attachmentCount: 0,
  fullBody: 'Hi Ryan, the townhouse at 12 Example St is an estate sale; the executor is handling it.', attachmentText: null,
})

test('V1: the seller, landlord and conversation extractors keep them too', async () => {
  ai.reply(() => openAiChat({ leads: [seller] }))
  const [s] = await extractSellerV1(input('Estate sale at 12 Example St'))
  assert.deepEqual([s.extractedTitle, s.extractedSummary, s.classificationReason, s.status],
    [seller.extractedTitle, SELLER_SUMMARY, seller.classificationReason, seller.status])
  assert.ok(lastPrompt().includes(MOTIVATION_LINE))
  assert.doesNotMatch(lastPrompt(), OLD_FILTER_LINE)

  ai.reply(() => openAiChat({ leads: [landlord] }))
  const [l] = await extractLandlordV1(input('Owners divorcing: 2BR to rent'))
  assert.deepEqual([l.extractedTitle, l.extractedSummary, l.classificationReason, l.status],
    [landlord.extractedTitle, LANDLORD_SUMMARY, landlord.classificationReason, landlord.status])

  ai.reply(() => openAiChat({ conversations: [conversation] }))
  const [c] = await extractConversationV1(input('Re: probate timing'))
  assert.deepEqual([c.extractedTitle, c.extractedSummary, c.classificationReason],
    [conversation.extractedTitle, CONVERSATION_SUMMARY, conversation.classificationReason])
  assert.doesNotMatch(lastPrompt(), OLD_FILTER_LINE)
})

test("V1: when extraction fails, the review row's title is the email subject, whatever it says", async () => {
  for (const [extract, key, subject] of [
    [extractSellerV1, 'leads', 'Estate sale at 12 Example St'],
    [extractLandlordV1, 'leads', 'Owners divorcing: 2BR to rent'],
    [extractConversationV1, 'conversations', 'Re: probate timing'],
  ] as const) {
    ai.reply(() => openAiChat({ [key]: [] }))
    const [r] = await extract(input(subject))
    assert.equal(r.processingStatus, 'needs_review')
    assert.equal(r.extractedTitle, subject)
  }
})

// The legacy extractor's answer for one email: a seller lead, a client
// conversation with the seller, and a landlord lead.
const legacy = [
  {
    isRelevant: true, category: 'SELLER_LEAD', transactionType: 'SALE', propertyType: 'townhouse', address: '12 Example St',
    neighborhood: 'Park Slope', borough: 'Brooklyn', city: 'Brooklyn', state: 'NY', zip: null, price: null, minPrice: null,
    maxPrice: null, beds: 4, baths: 2, units: 1, squareFeet: null, availabilityDate: null, sourceAgentName: 'Referring Agent',
    sourceAgentEmail: 'agent@example.com', sourceBrokerage: null, clientSide: 'seller', status: seller.status,
    extractedTitle: seller.extractedTitle, extractedSummary: seller.extractedSummary, classificationReason: seller.classificationReason,
    confidenceScore: 0.9,
  },
  {
    isRelevant: true, category: 'CLIENT_CONVERSATION', transactionType: 'UNKNOWN', propertyType: null, address: '12 Example St',
    neighborhood: 'Park Slope', borough: 'Brooklyn', city: 'New York', state: 'NY', zip: null, price: null, minPrice: null,
    maxPrice: null, beds: null, baths: null, units: null, squareFeet: null, availabilityDate: null, sourceAgentName: 'Referring Agent',
    sourceAgentEmail: 'agent@example.com', sourceBrokerage: null, clientSide: 'seller', status: 'Waiting on probate',
    extractedTitle: conversation.extractedTitle, extractedSummary: CONVERSATION_SUMMARY, classificationReason: conversation.classificationReason,
    confidenceScore: 0.8,
  },
  {
    isRelevant: true, category: 'LANDLORD_LEAD', transactionType: 'RENTAL', propertyType: 'multi-family', address: null,
    neighborhood: 'Bushwick', borough: 'Brooklyn', city: 'Brooklyn', state: 'NY', zip: null, price: 3200, minPrice: null,
    maxPrice: null, beds: 2, baths: 1, units: 2, squareFeet: null, availabilityDate: null, sourceAgentName: 'Referring Agent',
    sourceAgentEmail: 'agent@example.com', sourceBrokerage: null, clientSide: 'landlord', status: landlord.status,
    extractedTitle: landlord.extractedTitle, extractedSummary: landlord.extractedSummary, classificationReason: landlord.classificationReason,
    confidenceScore: 0.85,
  },
]
const email = {
  subject: 'Estate sale at 12 Example St', senderName: 'Referring Agent', senderEmail: 'agent@example.com',
  receivedDateTime: '2026-10-17T12:00:00Z', bodyPreview: 'Estate sale, the executor is handling it.',
}

test("the legacy extractor (Outlook sync, re-extract, reclassify) saves the provider's answer as it came", async () => {
  ai.reply(() => openAiChat({ opportunities: legacy }))
  assert.deepEqual(await classifyAndExtractEmail(email), legacy)
  process.env.AI_PROVIDER = 'anthropic'
  try {
    ai.reply(() => anthropicText(JSON.stringify({ opportunities: legacy })))
    assert.deepEqual(await classifyAndExtractEmail(email), legacy)
    assert.match(ai.requests[ai.requests.length - 1].url, /api\.anthropic\.com/)
  } finally {
    delete process.env.AI_PROVIDER
  }
})

test("the buried-lead second pass saves a recovered seller lead's own words", async () => {
  const created: Array<Record<string, unknown>> = []
  Object.assign(db, {
    rawEmail: { findUnique: async () => ({ id: 'raw-test', subject: 'Catching up', senderName: 'Referring Agent', senderEmail: 'agent@example.com', receivedDateTime: new Date('2026-10-17T12:00:00Z') }) },
    documentChunk: {
      findMany: async () => [{
        chunkType: 'email_body', pageNumber: null, sectionHeading: null, hasTable: false, parentAttachmentId: null, parentLinkedResourceId: null,
        content: 'Great to see you. The estate is selling the Park Slope townhouse in the spring; the executor is handling it.',
      }],
    },
    linkedResource: { findMany: async () => [] },
    attachment: { findMany: async () => [] },
    extractedOpportunity: {
      // Brief 48 (PR 15): the old recovered rows are read, then deleted with their matches.
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
      create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return { id: 'opp-test', ...data } },
    },
    match: { deleteMany: async () => ({ count: 0 }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  })
  const summary = 'Estate sale of a Park Slope townhouse; the executor is handling it'
  const reason = 'The sender says the estate will sell the townhouse in the spring.'
  ai.reply(() => anthropicTool('report_buried_lead', {
    found: true, category: 'SELLER_LEAD', clientSide: 'seller', neighborhood: 'Park Slope', borough: 'Brooklyn', address: null,
    price: null, beds: null, isHistoricalComp: false, confidence: 0.85, summary, reason,
  }))
  const { recoverAndPersistBuriedLead } = await v2()
  assert.ok(await recoverAndPersistBuriedLead('raw-test', 'org-test'))
  assert.equal(created.length, 1)
  assert.deepEqual([created[0].extractedTitle, created[0].extractedSummary, created[0].classificationReason],
    [summary, summary, `[lead-recovery second pass] ${reason}`])
})

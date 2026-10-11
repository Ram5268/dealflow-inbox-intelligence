import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { LEAD_CATEGORIES, leadFallbackTitle, safeLeadText, safeStatus, safeConversationText } from './extraction/personalCircumstances'

export interface EmailInput {
  subject: string
  senderName: string | null
  senderEmail: string | null
  receivedDateTime: string
  bodyPreview: string | null
  fullBody?: string | null
  attachmentText?: string | null
}

export interface ExtractionResult {
  isRelevant: boolean
  category: string
  transactionType: string
  propertyType: string | null
  address: string | null
  neighborhood: string | null
  borough: string | null
  city: string | null
  state: string | null
  zip: string | null
  price: number | null
  minPrice: number | null
  maxPrice: number | null
  beds: number | null
  baths: number | null
  units: number | null
  squareFeet: number | null
  availabilityDate: string | null
  sourceAgentName: string | null
  sourceAgentEmail: string | null
  sourceBrokerage: string | null
  clientSide: string | null
  status: string | null
  extractedTitle: string
  extractedSummary: string
  classificationReason: string
  confidenceScore: number
  // Phase 1+ fields (present when using new ingestion pipeline)
  processingStatus?: string
  propertyId?:       string | null
  flagReasons?:      string[]
  // Phase X.1 — populated when supply-side records get SE-matched at ingestion.
  // The legacy lib/ai.ts extractor doesn't populate these, but the new
  // lib/ingestion/ingestEmail.ts pipeline does. backgroundSync persists them.
  streetEasyId?:        string | null
  streetEasyStatus?:    string | null
  streetEasyCheckedAt?: Date | null
}

const SYSTEM_PROMPT = `You are a real estate deal intelligence classifier for Ryan Martin, a NYC Douglas Elliman agent.

Before classifying, answer these three questions:
1. SENDER ROLE: Who is this person? (listing agent, buyer's agent, property owner, building manager, developer, vendor, unknown)
2. OFFERING OR SEEKING: Are they offering something or seeking something?
3. TRANSACTION TYPE: Sale, rental, or unclear?

FULL CATEGORY LIST — use exactly these strings:

SUPPLY-SIDE (Properties Available):
  COMING_SOON_SALE — Off-market sale coming soon. Signals: "coming soon", "pre-market", "advance notice", "not yet on StreetEasy/MLS", "will be listing", Compass Coming Soon label
  COMING_SOON_RENTAL — Rental becoming available soon. Signals: rental context + future availability date, "coming available", "will be free [date]"
  OFF_MARKET_SALE — Private sale, no public listing. Signals: "off market", "pocket listing", "quiet sale", "select agents only", "not publicly available". NOTE: "Exclusive listing" = standard MLS listing, NOT off-market.
  ACTIVE_SALE_LISTING — Currently listed for sale publicly
  RENTAL_LISTING — Currently listed for rent publicly
  BACK_ON_MARKET — Was listed, went off, now back
  PRICE_DROP — Existing listing with price reduction
  DEVELOPMENT_INVENTORY — New construction, bulk new dev inventory, new buildings
  SPONSOR_UNIT — Developer/sponsor selling direct from offering plan (condo or co-op). Signals: "sponsor unit", "from offering plan", "sponsor sale", "no board approval"

DEMAND-SIDE (People Looking):
  BUYER_ISO — Another agent's buyer broadcasting search criteria. Ryan does NOT represent this buyer. Signals: "ISO", "my buyer needs", "client looking for", "buyer is searching", "in the market for"
  RENTER_INQUIRY — Another agent's renter or direct renter searching. Signals: "looking for rental", "needs apartment", "tenant needs", "renter inquiry"

LEAD-SIDE (Owners Ryan Can Pursue):
  SELLER_LEAD — Property owner considering selling. Homeowner outreach, sphere of influence.
  LANDLORD_LEAD — Property owner/manager with rental units seeking representation.

INFORMATIONAL:
  OPEN_HOUSE — Open house or broker preview announcement
  MARKET_REPORT — Market analysis, stats, absorption rates, reports, market newsletters with data
  REAL_ESTATE_EVENT — Grand openings, networking events, company events, new dev celebrations, broker events
  CLIENT_CONVERSATION — Two-way email thread with a buyer, seller, renter, landlord, or prospect. Contains acquisition criteria, preferences, or relationship context.
  SHOWING_CONFIRMATION — Confirmed showing appointment. Must contain: property address + confirmed date/time + contact name.

  NOISE — Not real estate relevant (admin, spam, billing, unrelated personal emails). isRelevant: false.

MULTI-LISTING RULE:
If the email contains multiple distinct listings (availability report, broker blast), extract EACH as a SEPARATE entry. One email = many entries.
- Availability report: one entry per unit (include unit number in address)
- Broker blast: one entry per property
- Single listing: one entry
- NOISE: one entry with isRelevant false

CRITICAL RULES:
- Classify by INTENT and RELATIONSHIP, not by specific words.
- Never invent addresses, prices, neighborhoods, beds, baths, or unit counts. Use null if not stated.
- classificationReason must answer the 3 questions then state the category.
- confidenceScore: 0.9+ unambiguous, 0.7-0.9 probable, 0.5-0.7 ambiguous, below 0.5 guessing.
- availabilityDate: extract move-in or available date (e.g. "June 4" → "2026-06-04"). Null if not stated.
- For SHOWING_CONFIRMATION: extract the showing date/time into availabilityDate field.
- For CLIENT_CONVERSATION: extract any buyer/renter criteria into the price/beds/neighborhood fields.

Return ONLY a valid JSON object with key "opportunities" containing an array. No markdown, no explanation outside the JSON.`

function buildPrompt(email: EmailInput): string {
  const body = email.fullBody
    ? `\nFull Body:\n${email.fullBody.slice(0, 8000)}`
    : ''
  const attachments = email.attachmentText
    ? `\nAttachment Content:\n${email.attachmentText.slice(0, 12000)}`
    : ''

  return `Extract all real estate opportunities from this email:

Subject: ${email.subject}
From: ${email.senderName || 'Unknown'} <${email.senderEmail || 'unknown'}>
Received: ${email.receivedDateTime}
Preview: ${email.bodyPreview || '(no preview)'}${body}${attachments}

Return a JSON object with key "opportunities" containing an array. Each item has these exact fields:
{
  "isRelevant": boolean,
  "category": string,
  "transactionType": string,
  "propertyType": string | null,
  "address": string | null,
  "neighborhood": string | null,
  "borough": string | null,
  "city": string | null,
  "state": string | null,
  "zip": string | null,
  "price": number | null,
  "minPrice": number | null,
  "maxPrice": number | null,
  "beds": number | null,
  "baths": number | null,
  "units": number | null,
  "squareFeet": number | null,
  "availabilityDate": string | null,
  "sourceAgentName": string | null,
  "sourceAgentEmail": string | null,
  "sourceBrokerage": string | null,
  "clientSide": string | null,
  "status": string | null,
  "extractedTitle": string,
  "extractedSummary": string,
  "classificationReason": string,
  "confidenceScore": number
}`
}

function parseResults(raw: unknown): ExtractionResult[] {
  if (!raw || typeof raw !== 'object') return []
  const obj = raw as Record<string, unknown>

  // Expected format: { opportunities: [...] }
  if (Array.isArray(obj.opportunities)) {
    return obj.opportunities as ExtractionResult[]
  }
  // Fallback: if model returned a plain array at top level (shouldn't happen with json_object mode)
  if (Array.isArray(raw)) {
    return raw as ExtractionResult[]
  }
  // Fallback: if model returned a single object (old format), wrap it
  if (obj.category !== undefined) {
    return [obj as unknown as ExtractionResult]
  }
  return []
}

async function extractWithOpenAI(email: EmailInput): Promise<ExtractionResult[]> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPrompt(email) },
    ],
    temperature: 0,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
  })
  const content = response.choices[0].message.content
  if (!content) throw new Error('OpenAI returned empty response')
  return parseResults(JSON.parse(content))
}

async function extractWithAnthropic(email: EmailInput): Promise<ExtractionResult[]> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildPrompt(email) }],
  })
  const block = response.content[0]
  if (block.type !== 'text') throw new Error('Anthropic returned non-text block')
  const text = block.text.trim()
  const jsonStart = text.indexOf('{')
  const jsonEnd = text.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1) throw new Error('No JSON in Anthropic response')
  return parseResults(JSON.parse(text.slice(jsonStart, jsonEnd + 1)))
}

export async function classifyAndExtractEmail(
  email: EmailInput
): Promise<ExtractionResult[]> {
  const provider = process.env.AI_PROVIDER ?? 'openai'
  const results = provider === 'anthropic' ? await extractWithAnthropic(email) : await extractWithOpenAI(email)
  return results.map(withoutPersonalLeadText)
}

// Brief 41 (H9): a seller's or landlord's personal circumstances (estate,
// probate, divorce, a death, illness) never reach a saved row. Every caller
// (sync/reextract, sync/reclassify, Outlook sync) saves these results.
// Brief 41.1: nor do they through a lead's status or a client conversation
// with a seller or landlord (or one whose side isn't clear).
export function withoutPersonalLeadText(r: ExtractionResult): ExtractionResult {
  const fallbackTitle = leadFallbackTitle(r.category, r.address ?? r.neighborhood)
  if (r.category === 'CLIENT_CONVERSATION') {
    const t = safeConversationText({
      clientSide: r.clientSide, title: r.extractedTitle, summary: r.extractedSummary, reason: r.classificationReason, fallbackTitle,
    })
    return { ...r, extractedTitle: t.title, extractedSummary: t.summary, classificationReason: t.reason }
  }
  if (!LEAD_CATEGORIES.has(r.category)) return r
  const t = safeLeadText({ title: r.extractedTitle, summary: r.extractedSummary, reason: r.classificationReason, fallbackTitle })
  return {
    ...r, extractedTitle: t.title, extractedSummary: t.summary, classificationReason: t.reason,
    status: typeof r.status === 'string' ? safeStatus(r.status) : r.status,
  }
}

export interface SearchCriteria {
  transactionType?: string
  neighborhoods?: string[]
  borough?: string
  maxPrice?: number
  minPrice?: number
  propertyType?: string
  beds?: number
  baths?: number
  units?: number
  desiredCategories?: string[]
}

const SEARCH_SYSTEM = `You are a real estate search query parser. Extract structured search criteria from natural language.
Return ONLY valid JSON with these fields (use null for missing values):
{
  "transactionType": string | null,
  "neighborhoods": string[] | null,
  "borough": string | null,
  "maxPrice": number | null,
  "minPrice": number | null,
  "propertyType": string | null,
  "beds": number | null,
  "baths": number | null,
  "units": number | null,
  "desiredCategories": string[] | null
}

Categories to use: COMING_SOON_SALE, COMING_SOON_RENTAL, OFF_MARKET_SALE, ACTIVE_SALE_LISTING, RENTAL_LISTING, BUYER_ISO, RENTER_INQUIRY, SELLER_LEAD, LANDLORD_LEAD, DEVELOPMENT_INVENTORY, SPONSOR_UNIT, OPEN_HOUSE, PRICE_DROP, BACK_ON_MARKET, MARKET_REPORT, REAL_ESTATE_EVENT, CLIENT_CONVERSATION, SHOWING_CONFIRMATION
Transaction types: SALE, RENTAL, BUYER_NEED, RENTER_NEED, SELLER_LEAD, LANDLORD_LEAD, UNKNOWN`

export async function parseSearchQuery(query: string): Promise<SearchCriteria> {
  const provider = process.env.AI_PROVIDER ?? 'openai'

  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: SEARCH_SYSTEM,
      messages: [{ role: 'user', content: `Parse this real estate search query: "${query}"` }],
    })
    const block = response.content[0]
    if (block.type !== 'text') throw new Error('Anthropic returned non-text')
    return JSON.parse(block.text) as SearchCriteria
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SEARCH_SYSTEM },
      { role: 'user', content: `Parse this real estate search query: "${query}"` },
    ],
    temperature: 0,
    response_format: { type: 'json_object' },
  })
  const content = response.choices[0].message.content
  if (!content) throw new Error('OpenAI returned empty')
  return JSON.parse(content) as SearchCriteria
}

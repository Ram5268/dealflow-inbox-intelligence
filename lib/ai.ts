import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

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
}

const SYSTEM_PROMPT = `You are a real estate deal intelligence classifier for Ryan Martin, a NYC Douglas Elliman agent.

Before classifying each listing, reason through these three questions:
1. SENDER ROLE: Who is this person? (listing agent, buyer's agent, property owner, building manager, developer, vendor, unknown)
2. OFFERING OR SEEKING: Are they offering something (a property, a unit, a deal) — or seeking something (a buyer, a renter, representation)?
3. TRANSACTION TYPE: Sale, rental, or unclear?

Your answers to those three questions determine the category. Use this decision tree:

OFFERING a property for SALE:
  Not yet public, quietly marketing → COMING_SOON_SALE
    Signals: "coming soon", "not yet on StreetEasy/MLS/OLR", "pre-market", "before it hits the market", "first access", "advance notice", "will be listing", Compass Coming Soon label
  Private, no public listing, pocket listing → OFF_MARKET_SALE
    Signals: "off market", "off-market", "not listed", "private exclusive", "pocket listing", "quiet sale", "quietly marketing", "private repositioning", "select agents only", "not publicly available", "price upon request" with no public listing context, agent-to-agent only with no MLS reference
  Actively listed on market now → ACTIVE_SALE_LISTING
    Note: "Exclusive listing" = agent holds the exclusive listing agreement (standard MLS listing, NOT off-market). Do NOT classify as OFF_MARKET_SALE just because "exclusive" appears.
  Previously listed, now back active → BACK_ON_MARKET
  Existing listing with price reduced → PRICE_DROP
  New construction, sponsor units, new dev → DEVELOPMENT_INVENTORY
  Open house announcement → OPEN_HOUSE

OFFERING a unit for RENT → RENTAL_LISTING

SEEKING a property to BUY:
  Any phrasing counts: "ISO", "my client needs", "buyer is looking", "in the market for", "searching for", "needs a home", "wants to purchase" → BUYER_ISO

SEEKING a place to RENT:
  Any phrasing counts: "looking for an apartment", "needs a rental", "moving to NYC", "renter inquiry", "tenant needs", "searching for a place" → RENTER_INQUIRY

Property OWNER considering selling (homeowner outreach, sphere of influence, "thinking of selling") → SELLER_LEAD

Property OWNER or BUILDING MANAGER with units to rent, seeking representation → LANDLORD_LEAD

Not real estate relevant (admin, personal, spam, billing, newsletters) → NOISE (isRelevant: false)

MULTI-LISTING RULE:
If the email or attachment contains multiple distinct listings (e.g., an availability report with several units or buildings, a broker blast with multiple properties), extract EACH listing as a SEPARATE entry in the opportunities array. Do not merge them into one. A single email can produce many entries.
- For an availability report: one entry per unit (include unit number in address, e.g. "225 East 95th Street, Unit D7L")
- For a broker blast: one entry per property
- For a single-listing email: array with exactly one entry
- For NOISE: array with one entry where isRelevant is false

CRITICAL RULES:
- Classify by INTENT and RELATIONSHIP — not by specific words or phrases. The exact wording never matters.
- Never invent addresses, prices, neighborhoods, beds, baths, or unit counts. Use null if not explicitly stated.
- classificationReason must state your answers to the 3 questions, then the category they point to.
- confidenceScore: 0.9+ = unambiguous, 0.7–0.9 = probable, 0.5–0.7 = ambiguous, below 0.5 = guessing.
- availabilityDate: extract move-in or available date if stated (e.g. "June 4" → "2026-06-04"). Use null if not stated.

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
  if (provider === 'anthropic') {
    return extractWithAnthropic(email)
  }
  return extractWithOpenAI(email)
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

Categories to use: COMING_SOON_SALE, OFF_MARKET_SALE, ACTIVE_SALE_LISTING, RENTAL_LISTING, BUYER_ISO, RENTER_INQUIRY, SELLER_LEAD, LANDLORD_LEAD, DEVELOPMENT_INVENTORY, OPEN_HOUSE, PRICE_DROP, BACK_ON_MARKET
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

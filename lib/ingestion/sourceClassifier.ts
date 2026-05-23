import OpenAI from 'openai'
import type { ClassifierInput, ClassifierOutput } from './types'
import { PROMPT_VERSION } from './types'

export const CLASSIFIER_VERSION = '1.0'

const SYSTEM_PROMPT = `You are a real estate email classifier for a NYC Douglas Elliman agent.

STEP 1 — READ THE SUBJECT FIRST. It is the strongest signal.
If the subject contains ANY of the following, classify as the appropriate real estate category, regardless of body content:
- A price: "$650,000", "$3,500/mo", "asking $X", "priced at $X"
- Bed/bath counts: "1 bed", "2BR", "1 bath", "studio"
- Listing words: "just listed", "new listing", "for sale", "for rent", "available", "price drop", "back on market", "off market", "coming soon", "open house", "price reduced"
- An address: any number followed by a street name ("317 East 18th St", "123 W 57th")
- ISO words: "ISO", "buyer looking", "client needs", "seeking"
Real estate emails often have generic or boilerplate bodies — the SUBJECT is what matters.

STEP 2 — CATEGORIES (classify into one):
Supply-side: COMING_SOON_SALE, COMING_SOON_RENTAL, OFF_MARKET_SALE, ACTIVE_SALE_LISTING, RENTAL_LISTING, BACK_ON_MARKET, PRICE_DROP, DEVELOPMENT_INVENTORY, COMING_SOON_DEVELOPMENT, SPONSOR_UNIT
Demand-side: BUYER_ISO, RENTER_INQUIRY
Lead-side: SELLER_LEAD, LANDLORD_LEAD
Informational: OPEN_HOUSE, MARKET_REPORT, REAL_ESTATE_EVENT, CLIENT_CONVERSATION, SHOWING_CONFIRMATION
NOISE — ONLY for emails with NO real estate content in the subject AND no useful body: IT support, billing, personal emails, vendor software pitches.

KEY DISTINCTIONS:
- COMING_SOON_DEVELOPMENT vs DEVELOPMENT_INVENTORY: Both are building-level new developments. Use COMING_SOON_DEVELOPMENT when the building is NOT yet on market — signals: "Coming Soon", "pre-launch", "VIP preview", "now accepting reservations", "estimated closings YYYY", "anticipated completion", "expected delivery", pricing TBD or future-oriented. Use DEVELOPMENT_INVENTORY when the building IS actively selling NOW — signals: "Now Selling", "Sales Gallery Open", "Now Available", "Grand Opening", current pricing listed, "immediate occupancy", "last remaining units".
- DEVELOPMENT_INVENTORY vs COMING_SOON_SALE: DEVELOPMENT_INVENTORY/COMING_SOON_DEVELOPMENT are building-level (multiple unit tiers, building name as headline, 10+ units). COMING_SOON_SALE is a single specific unit at a known address not yet on market.
- SPONSOR_UNIT: A single specific unit in a new development with its own unit number and price (not a full building announcement).
- SELLER_LEAD vs ACTIVE_SALE_LISTING: SELLER_LEAD = owner/agent reaching out to Ryan to list. ACTIVE_SALE_LISTING = already listed by another broker.
- CLIENT_CONVERSATION vs BUYER_ISO/RENTER_INQUIRY: CLIENT_CONVERSATION = direct back-and-forth with one person. BUYER_ISO/RENTER_INQUIRY = blast email broadcasting a client's criteria to many agents.
- BUYER_ISO vs RENTER_INQUIRY: BUYER_ISO = client wants to PURCHASE (budget in $100K–$10M+ range; words: "buy", "purchase", "closing", "mortgage", "down payment", "co-op", "condo", "townhouse"). RENTER_INQUIRY = client wants to RENT/LEASE (budget is monthly — $1,000–$30,000/mo; words: "rental", "lease", "rent", "per month", "/mo", "monthly", "no fee", "flex", "laundry", "doorman" without purchase language). CRITICAL: a monthly budget like "$8,500" or "$5K/mo" is always RENTER_INQUIRY, never BUYER_ISO.

STEP 3 — needsDeepExtract:
- true for all supply-side, demand-side, lead-side, OPEN_HOUSE, SHOWING_CONFIRMATION, CLIENT_CONVERSATION
- false for NOISE, MARKET_REPORT, REAL_ESTATE_EVENT (informational only)

ATTACHMENT GUIDANCE (only when subject is vague):
- Vague subject + attachment named "*.pdf" with listing keywords → supply-side category
- Vague subject + no attachments + body is generic newsletter text → NOISE

CONFIDENCE RULES: 0.9+ unambiguous, 0.7-0.89 probable, 0.5-0.69 ambiguous

MULTI-LISTING: Set isMultiListing=true when email contains multiple distinct listings.

Return ONLY valid JSON, no markdown:
{
  "category": string,
  "confidence": number,
  "needsDeepExtract": boolean,
  "isMultiListing": boolean
}`

// Email-client boilerplate that often appears as the first line of broker blast body previews.
// When detected, the preview is not useful — fall back to body text or subject only.
const BOILERPLATE_PATTERNS = [
  /^trouble viewing/i,
  /^view in browser/i,
  /^having trouble/i,
  /^if you.re having trouble/i,
  /^unsubscribe/i,
  /^powered by/i,
  /^click here to view/i,
]

function cleanPreview(preview: string | null): string | null {
  if (!preview) return null
  // Strip HTML entities
  const stripped = preview.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#\d+;/g, '').trim()
  // If it starts with boilerplate, discard it
  if (BOILERPLATE_PATTERNS.some(p => p.test(stripped))) return null
  return stripped.length > 10 ? stripped : null
}

function buildPrompt(input: ClassifierInput): string {
  const attachInfo = input.attachmentCount > 0
    ? `\nAttachments (${input.attachmentCount}): ${input.attachmentNames.join(', ')} [types: ${input.attachmentMimeTypes.join(', ')}]`
    : '\nAttachments: none'

  // Clean both body sources — discard boilerplate so it doesn't mislead the classifier
  const cleanedPreview  = cleanPreview(input.bodyPreview)
  const cleanedBody500  = cleanPreview(input.bodyFirst500)

  const bodyHint = cleanedPreview
    ? `\nPreview: ${cleanedPreview.slice(0, 300)}`
    : cleanedBody500
    ? `\nBody sample: ${cleanedBody500.slice(0, 400)}`
    : '\n(Body not useful — classify from subject and attachment names only)'

  return `Classify this email:
Subject: ${input.subject}
From: ${input.senderName ?? 'Unknown'} <${input.senderEmail ?? 'unknown'}>${attachInfo}${bodyHint}`
}

export async function sourceClassifier(input: ClassifierInput): Promise<ClassifierOutput> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  try {
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildPrompt(input) },
      ],
      temperature: 0,
      max_tokens: 120,
      response_format: { type: 'json_object' },
    })

    const raw = res.choices[0].message.content ?? '{}'
    const parsed = JSON.parse(raw)

    return {
      category:         parsed.category         ?? 'NOISE',
      confidence:       parsed.confidence        ?? 0.5,
      needsDeepExtract: parsed.needsDeepExtract  ?? false,
      isMultiListing:   parsed.isMultiListing    ?? false,
      extractorVersion: CLASSIFIER_VERSION,
    }
  } catch {
    return {
      category: 'NOISE', confidence: 0, needsDeepExtract: false,
      isMultiListing: false, extractorVersion: CLASSIFIER_VERSION,
    }
  }
}

// Build a stable idempotency key for this email + pipeline step
export function buildIdempotencyKey(
  rawEmailId: string,
  extractorType: string,
  version = PROMPT_VERSION
): string {
  return `${rawEmailId}::${extractorType}::v${version}`
}

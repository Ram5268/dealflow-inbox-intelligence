import OpenAI from 'openai'
import type { ClassifierInput, ClassifierOutput } from './types'
import { PROMPT_VERSION } from './types'

export const CLASSIFIER_VERSION = '1.1'

// Brief 6.3 — only these three categories skip deep extraction. Everything else
// has an extraction spec and must always deep-extract (see STEP 3 in the prompt).
const NO_DEEP_EXTRACT = new Set<string>(['NOISE', 'MARKET_REPORT', 'REAL_ESTATE_EVENT'])

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
- RESALE HOTSHEET vs NEW DEVELOPMENT: An email listing MULTIPLE units at DIFFERENT street addresses (a broker "hotsheet" of unrelated listings) → the resale category (COMING_SOON_SALE / ACTIVE_SALE_LISTING) with multiple listings, NOT DEVELOPMENT_INVENTORY/COMING_SOON_DEVELOPMENT. Development categories are ONLY for MULTIPLE units at the SAME building/address (one project, many unit lines).

BURIED INTENT & INFORMATIONAL TONE — do not let a friendly, chatty, or newsletter wrapper hide a real lead or listing. Route to a lead/listing category ONLY when someone expresses CONCRETE, ACTIONABLE intent that creates a NEW opportunity:
- SELLER_LEAD: the sender states concrete intent to LIST or SELL a specific property they own ("btw I'm thinking of listing my 2BR next month", "we're already thinking about selling the Chelsea apartment next spring"). Future intent counts — but it must be their OWN property and a real decision to sell.
- BUYER_ISO / RENTER_INQUIRY: a buyer/renter — including one referred by a colleague — with CONCRETE criteria (a neighborhood, budget, or bed count specific enough to act on, e.g. "my colleague's buyer wants a 2BR in Cobble Hill up to $1.6M").
- A newsletter / market-update email that ALSO contains a specific actionable listing (a real address + price, e.g. "New exclusive: 240 W 23rd St #4C, $875,000") → classify as that listing's category (e.g. ACTIVE_SALE_LISTING), NOT MARKET_REPORT. The concrete listing wins over the newsletter framing.
- HISTORICAL / SOLD-COMP references are NOT leads or inventory: a just-SOLD comparable forwarded for pricing context ("12 E 10th St just sold for $2.1M, good comp for yours"), or a past personal purchase ("I paid $1.8M for my last place") → MARKET_REPORT or NOISE, NEVER SELLER_LEAD or ACTIVE_SALE_LISTING, even when seller/price language appears. A closed comp is context, not a live deal.

KEEP AS CLIENT_CONVERSATION (do NOT promote to a lead) an ongoing back-and-forth with an existing client, even when buy/sell/price words appear:
- A reply about already-arranged showings or "what's realistic in our range" with no new concrete criteria ("Re: this weekend's showings — we loved the light but the kitchen felt tight").
- A seller deciding between offers or negotiating terms on a property that is ALREADY listed — that is a live deal in progress, not a new SELLER_LEAD.
- A client forwarding or reacting to someone ELSE's listing ("Fwd: what do you think of this one?", "is $1.1M crazy?") — they are reacting to it, not listing it (do not extract that listing as inventory).
- A vague or soft future/third-party mention with no actionable criteria ("my coworker might start looking someday, nothing serious").

SHOWING_CONFIRMATION PRECEDENCE: an email confirming, scheduling, or rescheduling a specific showing appointment (a date/time to see a property) is SHOWING_CONFIRMATION, even when it reads as a friendly reply — do not downgrade it to CLIENT_CONVERSATION, and do not treat the property being shown as a new RENTAL_LISTING or sale listing.

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
  const cleanedBody     = cleanPreview(input.bodyFirst500)

  // Brief 6.3: prefer the FULLER body over the short preview. Real emails bury the
  // actionable signal (a seller lead, a listing) at the BOTTOM — a newsletter's
  // exclusive, a chatty note's "btw I'm listing" — well past a 300-char preview.
  // bodyFirst500 now carries up to ~1200 chars (see ClassifierInput producers), so
  // give the model that window; fall back to the preview only when the body is thin.
  const bodyHint = cleanedBody
    ? `\nBody (first ${Math.min(cleanedBody.length, 1200)} chars): ${cleanedBody.slice(0, 1200)}`
    : cleanedPreview
    ? `\nPreview: ${cleanedPreview.slice(0, 300)}`
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

    const category = parsed.category ?? 'NOISE'
    return {
      category,
      confidence:       parsed.confidence        ?? 0.5,
      // Brief 6.3: derive needsDeepExtract from the category rather than trusting
      // the model's own boolean. STEP 3 already defines it deterministically, and
      // letting the LLM decide made it flip false on long/HTML bodies (OPEN_HOUSE /
      // PRICE_DROP emails skipping extraction). Only the three purely-informational
      // buckets skip deep extraction; every extractable category always runs.
      needsDeepExtract: !NO_DEEP_EXTRACT.has(category),
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

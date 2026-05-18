import OpenAI from 'openai'
import type { ClassifierInput, ClassifierOutput } from './types'
import { PROMPT_VERSION } from './types'

export const CLASSIFIER_VERSION = '1.0'

const SYSTEM_PROMPT = `You are a real estate email classifier for a NYC Douglas Elliman agent.

Your ONLY job: determine the category of this email and whether it needs deep extraction.

CATEGORIES:
Supply-side (properties available):
  COMING_SOON_SALE, COMING_SOON_RENTAL, OFF_MARKET_SALE, ACTIVE_SALE_LISTING, RENTAL_LISTING,
  BACK_ON_MARKET, PRICE_DROP, DEVELOPMENT_INVENTORY, SPONSOR_UNIT

Demand-side (people looking):
  BUYER_ISO — another agent's buyer broadcasting search criteria
  RENTER_INQUIRY — another agent's renter or direct renter searching

Lead-side:
  SELLER_LEAD, LANDLORD_LEAD

Informational:
  OPEN_HOUSE, MARKET_REPORT, REAL_ESTATE_EVENT, CLIENT_CONVERSATION, SHOWING_CONFIRMATION

Not useful:
  NOISE — spam, admin, billing, vendor pitches, unrelated content

ATTACHMENT GUIDANCE:
If the subject or preview is vague but attachment names suggest real estate content,
route to a supply-side or demand-side category, not NOISE.
Examples:
- "Updated availability" + "Williamsburg_Rentals_June.pdf" → RENTAL_LISTING
- "FYI" + "Tribeca_OffMarket_Condo.pdf" → OFF_MARKET_SALE
- "See attached" + "BuyerISO_Chelsea_2BR.pdf" → BUYER_ISO
- "Newsletter" + no attachments + generic body → NOISE

CONFIDENCE RULES:
0.9+ = unambiguous
0.7-0.89 = probable
0.5-0.69 = ambiguous
<0.5 = guessing

MULTI-LISTING: Set isMultiListing=true if email contains multiple distinct properties
(e.g. availability report, broker blast with multiple addresses).

NOISE check: Set needsDeepExtract=false ONLY when clearly not real estate relevant.

Return ONLY valid JSON, no markdown:
{
  "category": string,
  "confidence": number,
  "needsDeepExtract": boolean,
  "isMultiListing": boolean
}`

function buildPrompt(input: ClassifierInput): string {
  const attachInfo = input.attachmentCount > 0
    ? `\nAttachments (${input.attachmentCount}): ${input.attachmentNames.join(', ')} [types: ${input.attachmentMimeTypes.join(', ')}]`
    : '\nAttachments: none'

  const bodyHint = input.bodyFirst500 && (!input.bodyPreview || input.bodyPreview.length < 100)
    ? `\nBody sample: ${input.bodyFirst500.slice(0, 500)}`
    : (input.bodyPreview ? `\nPreview: ${input.bodyPreview.slice(0, 300)}` : '')

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

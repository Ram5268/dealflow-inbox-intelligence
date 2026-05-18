// Handles: ACTIVE_SALE_LISTING, OFF_MARKET_SALE, BACK_ON_MARKET, PRICE_DROP, OPEN_HOUSE
import OpenAI from 'openai'
import { z } from 'zod'
import type { ExtractorInput, ExtractionResult } from '../types'

export const EXTRACTOR_VERSION = '1.0'

const ListingItemSchema = z.object({
  address:          z.string().nullable(),
  neighborhood:     z.string().nullable(),
  borough:          z.string().nullable(),
  city:             z.string().nullable(),
  state:            z.string().nullable(),
  zip:              z.string().nullable(),
  price:            z.number().nullable(),
  beds:             z.number().nullable(),
  baths:            z.number().nullable(),
  squareFeet:       z.number().nullable(),
  units:            z.number().nullable().optional(),
  propertyType:     z.string().nullable(),
  availabilityDate: z.string().nullable(),
  status:           z.string().nullable(),
  category:         z.string(),
  transactionType:  z.string().nullish().transform(v => v ?? 'SALE'),
  sourceAgentName:  z.string().nullable(),
  sourceAgentEmail: z.string().nullable(),
  sourceBrokerage:  z.string().nullable(),
  extractedTitle:   z.string().nullish().transform(v => v ?? ''),
  extractedSummary: z.string().nullish().transform(v => v ?? ''),
  classificationReason: z.string().nullish().transform(v => v ?? ''),
  confidenceScore:  z.number().min(0).max(1).nullish().transform(v => v ?? 0.7),
})

const ResponseSchema = z.object({
  listings: z.array(ListingItemSchema),
})

const SYSTEM_PROMPT = `You are a NYC real estate sale listing extractor. Extract structured data from sale-related emails.

CATEGORIES to assign (pick the most accurate one):
- ACTIVE_SALE_LISTING — currently listed for sale publicly
- OFF_MARKET_SALE — private/pocket listing, not on public MLS. NOTE: "Exclusive listing" = standard MLS, NOT off-market.
- BACK_ON_MARKET — previously listed, went off, now back
- PRICE_DROP — existing listing with a price reduction
- OPEN_HOUSE — open house or broker preview announcement

SUBJECT LINE IS KEY: NYC broker blast emails often put the full listing details in the subject
(address, price, beds, baths) while the body is boilerplate HTML ("Trouble viewing this email...").
ALWAYS extract from the subject if it contains listing details, even if the body is empty or boilerplate.
Example: Subject "JUST LISTED AT 317 E 18TH ST #4A - 1 BED 1 BATH - ASKING $650,000"
→ address="317 East 18th Street #4A", beds=1, baths=1, price=650000, category=ACTIVE_SALE_LISTING

MULTI-LISTING: If the email contains multiple properties, extract each as a separate entry.

EXTRACTION RULES:
- Extract from subject line first, then body, then attachments.
- Never invent address, price, beds, baths, or neighborhood. Use null if not stated anywhere.
- price: number only (e.g. 650000, not "$650,000")
- beds/baths: number (e.g. 2, not "2BR")
- availabilityDate: ISO date string "YYYY-MM-DD" or null
- propertyType: condo, co-op, townhouse, multi-family, single-family, land, commercial
- transactionType: always "SALE"
- confidenceScore: 0.9+ unambiguous, 0.7-0.9 probable, 0.5-0.7 ambiguous

Return ONLY valid JSON: { "listings": [...] }
If you can extract any listing details (even just from the subject), always return at least one entry.`

function buildPrompt(input: ExtractorInput): string {
  const body = input.fullBody
    ? `\nFull Body:\n${input.fullBody.slice(0, 8000)}`
    : (input.bodyPreview ? `\nPreview: ${input.bodyPreview}` : '')
  const att = input.attachmentText
    ? `\n\nAttachment:\n${input.attachmentText.slice(0, 6000)}`
    : ''
  return `Extract all sale listings from this email:

Subject: ${input.subject}
From: ${input.senderName ?? 'Unknown'} <${input.senderEmail ?? ''}>
Attachments: ${input.attachmentNames.join(', ') || 'none'}${body}${att}`
}

export default async function extract(input: ExtractorInput): Promise<ExtractionResult[]> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  let raw: string
  try {
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildPrompt(input) },
      ],
      temperature: 0,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
    })
    raw = res.choices[0].message.content ?? '{}'
  } catch (err) {
    return [schemaFailed(input, (err as Error).message)]
  }

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [schemaFailed(input, 'JSON parse failed')] }

  const validated = ResponseSchema.safeParse(parsed)
  if (!validated.success) {
    return [schemaFailed(input, `Zod: ${validated.error.issues[0]?.message}`)]
  }

  if (validated.data.listings.length === 0) {
    return [schemaFailed(input, 'Extractor returned empty listings array')]
  }

  return validated.data.listings.map(l => ({
    isRelevant:           true,
    category:             l.category,
    transactionType:      l.transactionType,
    propertyType:         l.propertyType ?? null,
    address:              l.address ?? null,
    neighborhood:         l.neighborhood ?? null,
    borough:              l.borough ?? null,
    city:                 l.city ?? null,
    state:                l.state ?? null,
    zip:                  l.zip ?? null,
    price:                l.price ?? null,
    minPrice:             null,
    maxPrice:             null,
    beds:                 l.beds ?? null,
    baths:                l.baths ?? null,
    units:                (l.units ?? null) as number | null,
    squareFeet:           l.squareFeet ?? null,
    availabilityDate:     l.availabilityDate ?? null,
    sourceAgentName:      l.sourceAgentName ?? null,
    sourceAgentEmail:     l.sourceAgentEmail ?? null,
    sourceBrokerage:      l.sourceBrokerage ?? null,
    clientSide:           null,
    status:               l.status ?? null,
    extractedTitle:       l.extractedTitle,
    extractedSummary:     l.extractedSummary,
    classificationReason: l.classificationReason,
    confidenceScore:      l.confidenceScore,
  }))
}

function schemaFailed(input: ExtractorInput, reason: string): ExtractionResult {
  return {
    isRelevant:           true,
    category:             'ACTIVE_SALE_LISTING',
    transactionType:      'SALE',
    propertyType:         null,
    address:              null,
    neighborhood:         null,
    borough:              null,
    city:                 null,
    state:                null,
    zip:                  null,
    price:                null,
    minPrice:             null,
    maxPrice:             null,
    beds:                 null,
    baths:                null,
    units:                null,
    squareFeet:           null,
    availabilityDate:     null,
    sourceAgentName:      null,
    sourceAgentEmail:     null,
    sourceBrokerage:      null,
    clientSide:           null,
    status:               null,
    extractedTitle:       input.subject ?? '(sale listing)',
    extractedSummary:     'Extraction failed — requires manual review.',
    classificationReason: reason,
    confidenceScore:      0,
    flagReasons:          ['schema_validation_failed'],
    processingStatus:     'needs_review',
  }
}

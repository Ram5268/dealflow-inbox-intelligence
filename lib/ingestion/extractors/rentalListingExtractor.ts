// Handles: RENTAL_LISTING, COMING_SOON_RENTAL
import OpenAI from 'openai'
import { z } from 'zod'
import type { ExtractorInput, ExtractionResult } from '../types'

export const EXTRACTOR_VERSION = '1.0'

const RentalItemSchema = z.object({
  address:          z.string().nullable(),
  neighborhood:     z.string().nullable(),
  borough:          z.string().nullable(),
  city:             z.string().nullable(),
  state:            z.string().nullable(),
  zip:              z.string().nullable(),
  price:            z.number().nullable(),   // monthly rent (exact if known)
  minPrice:         z.number().nullable(),   // min rent if range given
  maxPrice:         z.number().nullable(),   // max rent if range given
  beds:             z.number().nullable(),
  baths:            z.number().nullable(),
  squareFeet:       z.number().nullable(),
  units:            z.number().nullable().optional(),
  propertyType:     z.string().nullable(),
  availabilityDate: z.string().nullable(),   // move-in date
  status:           z.string().nullable(),
  category:         z.string(),
  transactionType:  z.string().default('RENTAL'),
  sourceAgentName:  z.string().nullable(),
  sourceAgentEmail: z.string().nullable(),
  sourceBrokerage:  z.string().nullable(),
  extractedTitle:   z.string(),
  extractedSummary: z.string(),
  classificationReason: z.string(),
  confidenceScore:  z.number().min(0).max(1),
})

const ResponseSchema = z.object({
  listings: z.array(RentalItemSchema),
})

const SYSTEM_PROMPT = `You are a NYC real estate rental listing extractor. Extract structured data from rental emails.

CATEGORIES:
- RENTAL_LISTING — currently listed for rent
- COMING_SOON_RENTAL — rental becoming available soon (future move-in date, not yet on market)

MULTI-LISTING: If the email has multiple units/apartments, extract each as a separate entry.
Example: availability reports with "1BR $3,500 / 2BR $4,800" → two entries.

EXTRACTION RULES:
- Never invent address, rent, or beds. Use null if not stated.
- price: monthly rent as a number (e.g. 3500, not "$3,500/mo"). Use for exact rent.
- minPrice/maxPrice: use when a range is given (e.g. "$3,500-$4,000/mo")
- beds: number (2, not "2BR"). Studios = 0.
- availabilityDate: move-in date as "YYYY-MM-DD" or null
- propertyType: apartment, condo, co-op, townhouse, loft, room, etc.
- transactionType: always "RENTAL"
- category: RENTAL_LISTING if available now or already on market; COMING_SOON_RENTAL if future availability
- confidenceScore: 0.9+ unambiguous, 0.7-0.9 probable

Return ONLY valid JSON: { "listings": [...] }`

function buildPrompt(input: ExtractorInput): string {
  const body = input.fullBody
    ? `\nFull Body:\n${input.fullBody.slice(0, 8000)}`
    : (input.bodyPreview ? `\nPreview: ${input.bodyPreview}` : '')
  const att = input.attachmentText
    ? `\n\nAttachment:\n${input.attachmentText.slice(0, 6000)}`
    : ''
  return `Extract all rental listings from this email:

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
    minPrice:             l.minPrice ?? null,
    maxPrice:             l.maxPrice ?? null,
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
    category:             'RENTAL_LISTING',
    transactionType:      'RENTAL',
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
    extractedTitle:       input.subject ?? '(rental listing)',
    extractedSummary:     'Extraction failed — requires manual review.',
    classificationReason: reason,
    confidenceScore:      0,
    flagReasons:          ['schema_validation_failed'],
    processingStatus:     'needs_review',
  }
}

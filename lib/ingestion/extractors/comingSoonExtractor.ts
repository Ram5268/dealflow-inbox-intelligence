// Handles: COMING_SOON_SALE, COMING_SOON_RENTAL — individual pre-market units
import OpenAI from 'openai'
import { z } from 'zod'
import type { ExtractorInput, ExtractionResult } from '../types'

export const EXTRACTOR_VERSION = '1.0'

const ComingSoonItemSchema = z.object({
  address:          z.string().nullable(),
  neighborhood:     z.string().nullable(),
  borough:          z.string().nullable(),
  city:             z.string().nullable(),
  state:            z.string().nullable(),
  zip:              z.string().nullable(),
  price:            z.number().nullable(),
  minPrice:         z.number().nullable(),
  maxPrice:         z.number().nullable(),
  beds:             z.number().nullable(),
  baths:            z.number().nullable(),
  squareFeet:       z.number().nullable(),
  units:            z.number().nullable().optional(),
  propertyType:     z.string().nullable(),
  availabilityDate: z.string().nullable(),   // expected on-market or available date
  status:           z.string().nullable(),
  category:         z.string(),              // COMING_SOON_SALE or COMING_SOON_RENTAL
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
  listings: z.array(ComingSoonItemSchema),
})

const SYSTEM_PROMPT = `You are a NYC real estate extractor for pre-market listings. Extract structured data from "coming soon" emails about individual units not yet on market.

CATEGORIES:
- COMING_SOON_SALE — individual unit or property that will be listed for sale soon (not yet on MLS)
- COMING_SOON_RENTAL — individual unit that will be available for rent soon

DISTINGUISH FROM DEVELOPMENT_INVENTORY: Coming soon = single unit or small set of units at a specific address.
Development inventory = full building launch with multiple tier pricing ("1BR from $X, 2BR from $Y").

SUBJECT LINE IS KEY: Broker emails often put key details in the subject. Extract from subject first.

EXTRACTION RULES:
- Extract from subject line first, then body, then attachments
- address: specific unit address (e.g., "317 East 18th Street #4A"). Never null if stated in subject
- price: expected asking price as a number. For ranges, use minPrice/maxPrice
- availabilityDate: when the listing will go live or be available ("YYYY-MM-DD" or null)
- beds: number (0=studio). Never null if stated
- transactionType: "SALE" for COMING_SOON_SALE, "RENTAL" for COMING_SOON_RENTAL
- category: COMING_SOON_SALE or COMING_SOON_RENTAL
- confidenceScore: 0.9+ unambiguous, 0.7–0.9 probable

Return ONLY valid JSON: { "listings": [...] }`

function buildPrompt(input: ExtractorInput): string {
  const body = input.fullBody
    ? `\nFull Body:\n${input.fullBody.slice(0, 8000)}`
    : (input.bodyPreview ? `\nPreview: ${input.bodyPreview}` : '')
  const att = input.attachmentText
    ? `\n\nAttachment:\n${input.attachmentText.slice(0, 6000)}`
    : ''
  return `Extract all coming soon listings from this email:

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
    category:             'COMING_SOON_SALE',
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
    extractedTitle:       input.subject ?? '(coming soon listing)',
    extractedSummary:     'Extraction failed — requires manual review.',
    classificationReason: reason,
    confidenceScore:      0,
    flagReasons:          ['schema_validation_failed'],
    processingStatus:     'needs_review',
  }
}

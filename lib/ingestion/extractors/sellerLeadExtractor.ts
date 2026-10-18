// Handles: SELLER_LEAD — homeowner or agent indicating interest in listing a property for sale
import OpenAI from 'openai'
import { z } from 'zod'
import type { ExtractorInput, ExtractionResult } from '../types'

export const EXTRACTOR_VERSION = '1.0'

const SellerItemSchema = z.object({
  address:          z.string().nullable(),
  neighborhood:     z.string().nullable(),
  borough:          z.string().nullable(),
  city:             z.string().nullable(),
  state:            z.string().nullable(),
  zip:              z.string().nullable(),
  price:            z.number().nullable(),   // asking price or estimated value
  beds:             z.number().nullable(),
  baths:            z.number().nullable(),
  squareFeet:       z.number().nullable(),
  units:            z.number().nullable().optional(),
  propertyType:     z.string().nullable(),
  availabilityDate: z.string().nullable(),   // when they want to list
  status:           z.string().nullable(),
  sourceAgentName:  z.string().nullable(),   // the seller or referring agent
  sourceAgentEmail: z.string().nullable(),
  sourceBrokerage:  z.string().nullable(),
  motivation:       z.string().nullable(),   // why they're selling (divorce, estate, relocation, etc.)
  extractedTitle:   z.string().nullish().transform(v => v ?? ''),
  extractedSummary: z.string().nullish().transform(v => v ?? ''),
  classificationReason: z.string().nullish().transform(v => v ?? ''),
  confidenceScore:  z.number().min(0).max(1).nullish().transform(v => v ?? 0.7),
})

const ResponseSchema = z.object({
  leads: z.array(SellerItemSchema),
})

const SYSTEM_PROMPT = `You are a NYC real estate seller lead extractor. Extract structured data from emails where a homeowner or agent signals interest in listing a property for sale.

SELLER LEAD signals:
- Owner reaching out asking about listing their property
- Referral from another agent ("I have a potential seller at 123 Main St")
- Homeowner inquiry about market value or selling timeline
- An agent's client who owns a property and is considering listing

EXTRACTION RULES:
- address: the property address they want to list, if stated
- price: their asking price or estimated value if mentioned
- beds/baths/squareFeet: the property's details if stated
- motivation: brief note on why they're selling if mentioned (estate, divorce, relocation, downsizing, etc.)
- availabilityDate: when they're thinking of listing ("YYYY-MM-DD" or null)
- sourceAgentName/Email: the person who sent the email (seller or referring agent)
- propertyType: condo, co-op, townhouse, multi-family, etc.
- transactionType: always "SALE"
- Never invent address, price, or motivation. Use null if not stated
- confidenceScore: 0.9+ unambiguous, 0.7–0.9 probable

Return ONLY valid JSON: { "leads": [...] }`

function buildPrompt(input: ExtractorInput): string {
  const body = input.fullBody
    ? `\nFull Body:\n${input.fullBody.slice(0, 6000)}`
    : (input.bodyPreview ? `\nPreview: ${input.bodyPreview}` : '')
  const att = input.attachmentText
    ? `\n\nAttachment:\n${input.attachmentText.slice(0, 4000)}`
    : ''
  return `Extract seller lead details from this email:

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
      max_tokens: 1024,
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

  if (validated.data.leads.length === 0) {
    return [schemaFailed(input, 'Extractor returned empty leads array')]
  }

  return validated.data.leads.map(l => ({
    isRelevant:           true,
    category:             'SELLER_LEAD',
    transactionType:      'SALE',
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
    clientSide:           'seller',
    // Saved as the model returned them, estate, probate, divorce, death, illness
    // or age details included. Ryan's decision, 2026-10-17: saved seller notes
    // may keep these details. Buyer-facing text still never names motivation
    // (engineering precaution, Brief 41 H7).
    status:               l.status ?? null,
    extractedTitle:       l.extractedTitle,
    extractedSummary:     l.motivation ? `${l.extractedSummary} Motivation: ${l.motivation}` : l.extractedSummary,
    classificationReason: l.classificationReason,
    confidenceScore:      l.confidenceScore,
  }))
}

function schemaFailed(input: ExtractorInput, reason: string): ExtractionResult {
  return {
    isRelevant:           true,
    category:             'SELLER_LEAD',
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
    clientSide:           'seller',
    status:               null,
    extractedTitle:       input.subject ?? '(seller lead)',
    extractedSummary:     'Extraction failed — requires manual review.',
    classificationReason: reason,
    confidenceScore:      0,
    flagReasons:          ['schema_validation_failed'],
    processingStatus:     'needs_review',
  }
}

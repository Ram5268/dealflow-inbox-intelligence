// Handles: DEVELOPMENT_INVENTORY, SPONSOR_UNIT
import OpenAI from 'openai'
import { z } from 'zod'
import type { ExtractorInput, ExtractionResult } from '../types'

export const EXTRACTOR_VERSION = '1.0'

const DevItemSchema = z.object({
  address:          z.string().nullable(),
  neighborhood:     z.string().nullable(),
  borough:          z.string().nullable(),
  city:             z.string().nullable(),
  state:            z.string().nullable(),
  zip:              z.string().nullable(),
  beds:             z.number().nullable(),
  baths:            z.number().nullable(),
  squareFeet:       z.number().nullable(),
  units:            z.number().nullable().optional(),   // total units in building
  price:            z.number().nullable(),              // exact price if known
  minPrice:         z.number().nullable(),              // "starting from" price
  maxPrice:         z.number().nullable(),              // top of range
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
  listings: z.array(DevItemSchema),
})

const SYSTEM_PROMPT = `You are a NYC new development real estate extractor. Extract structured data from new development building announcements and sponsor unit emails.

CATEGORIES:
- DEVELOPMENT_INVENTORY — building-level launch: price sheets, inventory emails, announcements with multiple unit types or "starting from" prices, full building introductions
- SPONSOR_UNIT — single specific sponsor unit in a new or conversion development (has a specific unit number, e.g. "Residence 4B" or "Unit 12A")

EXTRACTION RULES:
- Extract one entry per UNIT TYPE when the email gives tier-based pricing (1BR, 2BR, 3BR, etc.)
- If specific named units are listed (Unit 4A, Residence 12B), extract each as a separate SPONSOR_UNIT entry
- address: the building STREET ADDRESS only — never the building name
  Example: "95 Madison Avenue" not "95 Madison Residences"
  If the email only gives a building name, infer the street address if widely known (e.g., "95 Madison" → "95 Madison Avenue"), otherwise use null
- units: total number of units in the building/development if stated (e.g., "sixty-five residences" → 65)
- beds: 0=studio, 1=1BR, 2=2BR, etc. Use null for unknown
- price: exact price only. For "starting from" amounts, use minPrice instead (leave price null)
- minPrice: "starting from" or lowest price in a range, as a number (e.g. 1095800)
- maxPrice: top of price range if given
- propertyType: condo, co-op, townhouse. New developments are almost always condo
- transactionType: always "SALE"
- extractedTitle: building name + unit type (e.g. "95 Madison Residences — 2BR")
- extractedSummary: one sentence with unit type, price range, and neighborhood
- confidenceScore: 0.9+ if address + pricing are clear, 0.7–0.9 probable

Return ONLY valid JSON: { "listings": [...] }`

function buildPrompt(input: ExtractorInput): string {
  const body = input.fullBody
    ? `\nFull Body:\n${input.fullBody.slice(0, 8000)}`
    : (input.bodyPreview ? `\nPreview: ${input.bodyPreview}` : '')
  const att = input.attachmentText
    ? `\n\nAttachment:\n${input.attachmentText.slice(0, 6000)}`
    : ''
  return `Extract all new development listings from this email:

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
    category:             'DEVELOPMENT_INVENTORY',
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
    extractedTitle:       input.subject ?? '(development listing)',
    extractedSummary:     'Extraction failed — requires manual review.',
    classificationReason: reason,
    confidenceScore:      0,
    flagReasons:          ['schema_validation_failed'],
    processingStatus:     'needs_review',
  }
}

// Handles: LANDLORD_LEAD — landlord looking to rent a unit or work with an agent
import OpenAI from 'openai'
import { z } from 'zod'
import type { ExtractorInput, ExtractionResult } from '../types'
import { safeLeadText, leadFallbackTitle, mentionsPersonalCircumstances } from '../../extraction/personalCircumstances'

export const EXTRACTOR_VERSION = '1.0'

const LandlordItemSchema = z.object({
  address:          z.string().nullable(),
  neighborhood:     z.string().nullable(),
  borough:          z.string().nullable(),
  city:             z.string().nullable(),
  state:            z.string().nullable(),
  zip:              z.string().nullable(),
  price:            z.number().nullable(),   // asking monthly rent
  minPrice:         z.number().nullable(),
  maxPrice:         z.number().nullable(),
  beds:             z.number().nullable(),
  baths:            z.number().nullable(),
  squareFeet:       z.number().nullable(),
  units:            z.number().nullable().optional(),
  propertyType:     z.string().nullable(),
  availabilityDate: z.string().nullable(),   // when available to rent
  status:           z.string().nullable(),
  sourceAgentName:  z.string().nullable(),   // landlord or referring agent
  sourceAgentEmail: z.string().nullable(),
  sourceBrokerage:  z.string().nullable(),
  leaseType:        z.string().nullable(),   // "12-month", "month-to-month", etc.
  extractedTitle:   z.string().nullish().transform(v => v ?? ''),
  extractedSummary: z.string().nullish().transform(v => v ?? ''),
  classificationReason: z.string().nullish().transform(v => v ?? ''),
  confidenceScore:  z.number().min(0).max(1).nullish().transform(v => v ?? 0.7),
})

const ResponseSchema = z.object({
  leads: z.array(LandlordItemSchema),
})

const SYSTEM_PROMPT = `You are a NYC real estate landlord lead extractor. Extract structured data from emails where a landlord is looking to rent a unit and wants agent representation.

LANDLORD LEAD signals:
- Landlord reaching out about listing a rental unit
- Referral from another agent ("I have a landlord with a 2BR in the West Village")
- Building owner looking for a tenant
- Property manager seeking to fill a vacancy

EXTRACTION RULES:
- address: the rental property address, if stated
- price: the asking monthly rent as a number (e.g. 4500, not "$4,500/mo")
- beds/baths/squareFeet: the unit's details if stated
- leaseType: "12-month", "month-to-month", "flexible", or null
- availabilityDate: when the unit is available ("YYYY-MM-DD" or null)
- sourceAgentName/Email: the person who sent the email
- propertyType: apartment, condo, co-op, townhouse, multi-family, etc.
- transactionType: always "RENTAL"
- Never invent address, rent, or details. Use null if not stated
- confidenceScore: 0.9+ unambiguous, 0.7–0.9 probable

Return ONLY valid JSON: { "leads": [...] }`

function buildPrompt(input: ExtractorInput): string {
  const body = input.fullBody
    ? `\nFull Body:\n${input.fullBody.slice(0, 6000)}`
    : (input.bodyPreview ? `\nPreview: ${input.bodyPreview}` : '')
  const att = input.attachmentText
    ? `\n\nAttachment:\n${input.attachmentText.slice(0, 4000)}`
    : ''
  return `Extract landlord lead details from this email:

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
    category:             'LANDLORD_LEAD',
    transactionType:      'RENTAL',
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
    clientSide:           'landlord',
    status:               l.status ?? null,
    // Brief 41 (H9): the same filter as seller leads (V2 mapLandlord too).
    ...(({ title, summary, reason }) => ({ extractedTitle: title, extractedSummary: summary, classificationReason: reason }))(
      safeLeadText({
        title: l.extractedTitle,
        summary: l.leaseType ? `${l.extractedSummary} Lease: ${l.leaseType}` : l.extractedSummary,
        reason: l.classificationReason,
        fallbackTitle: leadFallbackTitle('LANDLORD_LEAD', l.address ?? l.neighborhood),
      }),
    ),
    confidenceScore:      l.confidenceScore,
  }))
}

function schemaFailed(input: ExtractorInput, reason: string): ExtractionResult {
  return {
    isRelevant:           true,
    category:             'LANDLORD_LEAD',
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
    clientSide:           'landlord',
    status:               null,
    extractedTitle:       input.subject && !mentionsPersonalCircumstances(input.subject) ? input.subject : '(landlord lead)',
    extractedSummary:     'Extraction failed — requires manual review.',
    classificationReason: reason,
    confidenceScore:      0,
    flagReasons:          ['schema_validation_failed'],
    processingStatus:     'needs_review',
  }
}

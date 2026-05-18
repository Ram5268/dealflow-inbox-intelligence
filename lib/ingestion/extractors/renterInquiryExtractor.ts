// Handles: RENTER_INQUIRY — another agent's renter broadcasting search criteria
// Also stashes _criteriaProfile for CriteriaProfile creation in backgroundSync
import OpenAI from 'openai'
import { z } from 'zod'
import type { ExtractorInput, ExtractionResult } from '../types'

export const EXTRACTOR_VERSION = '1.0'

const RenterItemSchema = z.object({
  neighborhoods:    z.array(z.string()).default([]),
  borough:          z.string().nullable(),
  maxPrice:         z.number().nullable(),   // max monthly rent budget
  minPrice:         z.number().nullable(),   // min monthly rent budget (if stated)
  minBeds:          z.number().int().nullable(),
  maxBeds:          z.number().int().nullable(),
  beds:             z.number().nullable(),   // exact if specified
  moveInDate:       z.string().nullable(),   // "YYYY-MM-DD" or null
  propertyTypes:    z.array(z.string()).default([]),
  mustHaves:        z.string().nullable(),
  dealbreakers:     z.string().nullable(),
  sourceAgentName:  z.string().nullable(),
  sourceAgentEmail: z.string().nullable(),
  sourceBrokerage:  z.string().nullable(),
  extractedTitle:   z.string(),
  extractedSummary: z.string(),
  classificationReason: z.string(),
  confidenceScore:  z.number().min(0).max(1),
})

const ResponseSchema = z.object({
  renters: z.array(RenterItemSchema),
})

const SYSTEM_PROMPT = `You are a NYC real estate renter inquiry extractor. Extract structured renter search criteria from agent broadcast emails.

RENTER INQUIRY = another agent's renter client is looking for an apartment to rent.
Ryan does NOT represent this renter. This is a co-brokering opportunity — Ryan can match his rental listings to their search.

ONE EMAIL, POSSIBLY MULTIPLE RENTERS: If an agent represents multiple renter clients, extract each as a separate entry.

EXTRACTION RULES:
- neighborhoods: list ALL neighborhoods mentioned (e.g. ["Williamsburg", "Greenpoint", "Bushwick"])
- borough: Brooklyn, Manhattan, Queens, Bronx, Staten Island — if mentioned, otherwise null
- maxPrice: the renter's maximum monthly rent budget as a number (e.g. 4500, not "$4,500/mo")
- minPrice: minimum budget if stated (often not given)
- beds: exact bed count if specified. minBeds/maxBeds if a range. 0 = studio
- moveInDate: when they need to move in as "YYYY-MM-DD" or null if flexible/unspecified
- propertyTypes: list types mentioned ["apartment", "condo", "townhouse", "loft"]
- mustHaves: brief summary of must-have criteria (laundry, dishwasher, outdoor space, pets ok, etc.)
- dealbreakers: brief summary of dealbreakers if mentioned
- sourceAgentName/Email/Brokerage: the SENDING agent's info, not the renter's
- Never invent budget, beds, or neighborhoods. Use null/[] if not stated
- confidenceScore: 0.9+ unambiguous, 0.7–0.9 probable

Return ONLY valid JSON: { "renters": [...] }`

function buildPrompt(input: ExtractorInput): string {
  const body = input.fullBody
    ? `\nFull Body:\n${input.fullBody.slice(0, 6000)}`
    : (input.bodyPreview ? `\nPreview: ${input.bodyPreview}` : '')
  const att = input.attachmentText
    ? `\n\nAttachment:\n${input.attachmentText.slice(0, 4000)}`
    : ''
  return `Extract renter search criteria from this email:

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

  if (validated.data.renters.length === 0) {
    return [schemaFailed(input, 'Extractor returned empty renters array')]
  }

  return validated.data.renters.map(r => {
    const primaryNeighborhood = r.neighborhoods[0] ?? null

    const beds = r.beds ?? (
      r.minBeds != null && r.maxBeds != null
        ? (r.minBeds + r.maxBeds) / 2
        : r.maxBeds ?? r.minBeds ?? null
    )

    const summary = [
      r.neighborhoods.length > 0 ? r.neighborhoods.join(' / ') : null,
      r.maxPrice ? `up to $${r.maxPrice.toLocaleString()}/mo` : null,
      beds != null ? `${beds}BR` : null,
      r.mustHaves ? `Needs: ${r.mustHaves}` : null,
    ].filter(Boolean).join(' · ')

    return {
      isRelevant:           true,
      category:             'RENTER_INQUIRY',
      transactionType:      'RENTER_NEED',
      propertyType:         r.propertyTypes[0] ?? null,
      address:              null,
      neighborhood:         primaryNeighborhood,
      borough:              r.borough ?? null,
      city:                 'New York',
      state:                'NY',
      zip:                  null,
      price:                r.maxPrice ?? null,
      minPrice:             r.minPrice ?? null,
      maxPrice:             r.maxPrice ?? null,
      beds,
      baths:                null,
      units:                null,
      squareFeet:           null,
      availabilityDate:     r.moveInDate ?? null,
      sourceAgentName:      r.sourceAgentName ?? null,
      sourceAgentEmail:     r.sourceAgentEmail ?? null,
      sourceBrokerage:      r.sourceBrokerage ?? null,
      clientSide:           'renter',
      status:               null,
      extractedTitle:       r.extractedTitle,
      extractedSummary:     summary || r.extractedSummary,
      classificationReason: r.classificationReason,
      confidenceScore:      r.confidenceScore,
      _criteriaProfile: {
        type:          'renter',
        neighborhoods: r.neighborhoods,
        borough:       r.borough,
        minPrice:      r.minPrice,
        maxPrice:      r.maxPrice,
        minBeds:       r.minBeds,
        maxBeds:       r.maxBeds,
        propertyTypes: r.propertyTypes,
        notes:         [r.mustHaves, r.dealbreakers].filter(Boolean).join('\n') || null,
        agentName:     r.sourceAgentName,
        agentEmail:    r.sourceAgentEmail,
        brokerage:     r.sourceBrokerage,
      },
    } as ExtractionResult & { _criteriaProfile?: object }
  })
}

function schemaFailed(input: ExtractorInput, reason: string): ExtractionResult {
  return {
    isRelevant:           true,
    category:             'RENTER_INQUIRY',
    transactionType:      'RENTER_NEED',
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
    clientSide:           'renter',
    status:               null,
    extractedTitle:       input.subject ?? '(renter inquiry)',
    extractedSummary:     'Extraction failed — requires manual review.',
    classificationReason: reason,
    confidenceScore:      0,
    flagReasons:          ['schema_validation_failed'],
    processingStatus:     'needs_review',
  }
}

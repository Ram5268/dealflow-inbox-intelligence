// Handles: BUYER_ISO — another agent's buyer broadcasting search criteria
// Also creates a CriteriaProfile record after saving the opportunity (handled in backgroundSync)
import OpenAI from 'openai'
import { z } from 'zod'
import type { ExtractorInput, ExtractionResult } from '../types'

export const EXTRACTOR_VERSION = '1.0'

const ISOItemSchema = z.object({
  neighborhoods:    z.array(z.string()).default([]),
  borough:          z.string().nullable(),
  minPrice:         z.number().nullable(),
  maxPrice:         z.number().nullable(),
  minBeds:          z.number().int().nullable(),
  maxBeds:          z.number().int().nullable(),
  beds:             z.number().nullable(),    // single bed count if exact
  propertyTypes:    z.array(z.string()).default([]),
  mustHaves:        z.string().nullable(),
  dealbreakers:     z.string().nullable(),
  timeline:         z.string().nullable(),   // "wants to close by July", "flexible", etc.
  sourceAgentName:  z.string().nullable(),
  sourceAgentEmail: z.string().nullable(),
  sourceBrokerage:  z.string().nullable(),
  clientSide:       z.string().nullable(),
  extractedTitle:   z.string(),
  extractedSummary: z.string(),
  classificationReason: z.string(),
  confidenceScore:  z.number().min(0).max(1),
})

const ResponseSchema = z.object({
  isos: z.array(ISOItemSchema),
})

const SYSTEM_PROMPT = `You are a NYC real estate buyer ISO extractor. Extract structured buyer search criteria from agent broadcasts.

BUYER ISO = another agent's buyer is actively looking. Ryan does NOT represent this buyer.
This is a co-brokering opportunity — Ryan can match his listings to their search.

ONE EMAIL, POSSIBLY MULTIPLE BUYERS: If an agent emails about multiple buyers with different
criteria, extract each buyer as a separate entry.

EXTRACTION RULES:
- neighborhoods: list ALL neighborhoods mentioned (e.g. ["Tribeca", "SoHo", "West Village"])
- borough: extract if mentioned, otherwise null
- minPrice/maxPrice: the buyer's budget range as numbers (e.g. 2000000, not "$2M")
- beds: exact bed count if specified. minBeds/maxBeds if a range.
- propertyTypes: list all types mentioned ["condo", "co-op", "townhouse"]
- mustHaves: brief summary of must-have criteria (outdoor space, doorman, parking, etc.)
- dealbreakers: brief summary of dealbreakers if mentioned
- timeline: when they want to close or move in
- sourceAgentName/sourceAgentEmail/sourceBrokerage: the SENDING agent's info, NOT the buyer's
- clientSide: always "buyer"
- Never invent budget, beds, or neighborhoods. Use null/[] if not stated.
- confidenceScore: 0.9+ unambiguous, 0.7-0.9 probable

Return ONLY valid JSON: { "isos": [...] }`

function buildPrompt(input: ExtractorInput): string {
  const body = input.fullBody
    ? `\nFull Body:\n${input.fullBody.slice(0, 6000)}`
    : (input.bodyPreview ? `\nPreview: ${input.bodyPreview}` : '')
  const att = input.attachmentText
    ? `\n\nAttachment:\n${input.attachmentText.slice(0, 4000)}`
    : ''
  return `Extract buyer ISO search criteria from this email:

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

  if (validated.data.isos.length === 0) {
    return [schemaFailed(input, 'Extractor returned empty isos array')]
  }

  return validated.data.isos.map(iso => {
    // Use first neighborhood as the primary neighborhood field (for backward compat)
    const primaryNeighborhood = iso.neighborhoods[0] ?? null

    // Derive a single price for the price field (midpoint of range, or max)
    const price = iso.minPrice && iso.maxPrice
      ? Math.round((iso.minPrice + iso.maxPrice) / 2)
      : iso.maxPrice ?? iso.minPrice ?? null

    // Beds: use exact if available, else midpoint of range
    const beds = iso.beds ?? (
      iso.minBeds != null && iso.maxBeds != null
        ? (iso.minBeds + iso.maxBeds) / 2
        : iso.maxBeds ?? iso.minBeds ?? null
    )

    const summary = [
      iso.neighborhoods.length > 0 ? iso.neighborhoods.join(' / ') : null,
      iso.minPrice && iso.maxPrice ? `$${(iso.minPrice/1e6).toFixed(1)}M–$${(iso.maxPrice/1e6).toFixed(1)}M` : null,
      beds ? `${beds}BR` : null,
      iso.propertyTypes.length > 0 ? iso.propertyTypes.join('/') : null,
      iso.mustHaves ? `Needs: ${iso.mustHaves}` : null,
    ].filter(Boolean).join(' · ')

    return {
      isRelevant:           true,
      category:             'BUYER_ISO',
      transactionType:      'BUYER_NEED',
      propertyType:         iso.propertyTypes[0] ?? null,
      address:              null,                     // demand-side, no address
      neighborhood:         primaryNeighborhood,
      borough:              iso.borough ?? null,
      city:                 'New York',
      state:                'NY',
      zip:                  null,
      price,
      minPrice:             iso.minPrice ?? null,
      maxPrice:             iso.maxPrice ?? null,
      beds,
      baths:                null,
      units:                null,
      squareFeet:           null,
      availabilityDate:     iso.timeline ?? null,
      sourceAgentName:      iso.sourceAgentName ?? null,
      sourceAgentEmail:     iso.sourceAgentEmail ?? null,
      sourceBrokerage:      iso.sourceBrokerage ?? null,
      clientSide:           'buyer',
      status:               null,
      extractedTitle:       iso.extractedTitle,
      extractedSummary:     summary || iso.extractedSummary,
      classificationReason: iso.classificationReason,
      confidenceScore:      iso.confidenceScore,
      // Stash full criteria for CriteriaProfile creation in backgroundSync
      _criteriaProfile: {
        type:          'buyer',
        neighborhoods: iso.neighborhoods,
        borough:       iso.borough,
        minPrice:      iso.minPrice,
        maxPrice:      iso.maxPrice,
        minBeds:       iso.minBeds,
        maxBeds:       iso.maxBeds,
        propertyTypes: iso.propertyTypes,
        notes:         [iso.mustHaves, iso.dealbreakers, iso.timeline].filter(Boolean).join('\n') || null,
        agentName:     iso.sourceAgentName,
        agentEmail:    iso.sourceAgentEmail,
        brokerage:     iso.sourceBrokerage,
      },
    } as ExtractionResult & { _criteriaProfile?: object }
  })
}

function schemaFailed(input: ExtractorInput, reason: string): ExtractionResult {
  return {
    isRelevant:           true,
    category:             'BUYER_ISO',
    transactionType:      'BUYER_NEED',
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
    clientSide:           'buyer',
    status:               null,
    extractedTitle:       input.subject ?? '(buyer ISO)',
    extractedSummary:     'Extraction failed — requires manual review.',
    classificationReason: reason,
    confidenceScore:      0,
    flagReasons:          ['schema_validation_failed'],
    processingStatus:     'needs_review',
  }
}

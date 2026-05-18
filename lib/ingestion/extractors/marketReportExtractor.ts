// Handles: MARKET_REPORT, REAL_ESTATE_EVENT — informational emails, no specific listing
import OpenAI from 'openai'
import { z } from 'zod'
import type { ExtractorInput, ExtractionResult } from '../types'

export const EXTRACTOR_VERSION = '1.0'

const ReportItemSchema = z.object({
  category:         z.string(),              // MARKET_REPORT or REAL_ESTATE_EVENT
  neighborhood:     z.string().nullable(),   // primary market covered
  borough:          z.string().nullable(),
  eventDate:        z.string().nullable(),   // for events: "YYYY-MM-DD"
  eventLocation:    z.string().nullable(),   // venue for events
  publisher:        z.string().nullable(),   // who published the report
  periodCovered:    z.string().nullable(),   // e.g. "Q1 2025" or "April 2025"
  keyTakeaway:      z.string().nullable(),   // one sentence summary of main finding
  sourceAgentName:  z.string().nullable(),
  sourceAgentEmail: z.string().nullable(),
  sourceBrokerage:  z.string().nullable(),
  extractedTitle:   z.string().nullish().transform(v => v ?? ''),
  extractedSummary: z.string().nullish().transform(v => v ?? ''),
  classificationReason: z.string().nullish().transform(v => v ?? ''),
  confidenceScore:  z.number().min(0).max(1).nullish().transform(v => v ?? 0.7),
})

const ResponseSchema = z.object({
  items: z.array(ReportItemSchema),
})

const SYSTEM_PROMPT = `You are a NYC real estate informational email extractor. Extract structured data from market reports and real estate event announcements.

CATEGORIES:
- MARKET_REPORT — market data emails: quarterly reports, price trend summaries, inventory stats, neighborhood analysis
- REAL_ESTATE_EVENT — conference announcements, broker networking events, CE class reminders, panel discussions

EXTRACTION RULES:
- category: MARKET_REPORT or REAL_ESTATE_EVENT
- neighborhood: primary neighborhood or market area covered (null if city-wide)
- borough: if specific to one borough
- eventDate: for REAL_ESTATE_EVENT only — the event date as "YYYY-MM-DD"
- eventLocation: venue or "Virtual/Zoom" for REAL_ESTATE_EVENT
- publisher: company or person who published the report (e.g. "StreetEasy", "Douglas Elliman Research")
- periodCovered: time period for MARKET_REPORT (e.g. "Q1 2026", "April 2026")
- keyTakeaway: one sentence capturing the main finding or event hook
- sourceAgentName/Email/Brokerage: sender info
- extractedSummary: 1–2 sentences summarizing the report or event
- confidenceScore: 0.9+ clear, 0.7–0.9 probable

Return ONLY valid JSON: { "items": [...] }`

function buildPrompt(input: ExtractorInput): string {
  const body = input.fullBody
    ? `\nFull Body:\n${input.fullBody.slice(0, 6000)}`
    : (input.bodyPreview ? `\nPreview: ${input.bodyPreview}` : '')
  const att = input.attachmentText
    ? `\n\nAttachment:\n${input.attachmentText.slice(0, 4000)}`
    : ''
  return `Extract market report or event details from this email:

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

  if (validated.data.items.length === 0) {
    return [schemaFailed(input, 'Extractor returned empty items array')]
  }

  return validated.data.items.map(item => ({
    isRelevant:           true,
    category:             item.category,
    transactionType:      'INFORMATIONAL',
    propertyType:         null,
    address:              item.eventLocation ?? null,
    neighborhood:         item.neighborhood ?? null,
    borough:              item.borough ?? null,
    city:                 'New York',
    state:                'NY',
    zip:                  null,
    price:                null,
    minPrice:             null,
    maxPrice:             null,
    beds:                 null,
    baths:                null,
    units:                null,
    squareFeet:           null,
    availabilityDate:     item.eventDate ?? null,
    sourceAgentName:      item.sourceAgentName ?? null,
    sourceAgentEmail:     item.sourceAgentEmail ?? null,
    sourceBrokerage:      item.sourceBrokerage ?? item.publisher ?? null,
    clientSide:           null,
    status:               null,
    extractedTitle:       item.extractedTitle,
    extractedSummary:     item.keyTakeaway ? `${item.extractedSummary} Key finding: ${item.keyTakeaway}` : item.extractedSummary,
    classificationReason: item.classificationReason,
    confidenceScore:      item.confidenceScore,
  }))
}

function schemaFailed(input: ExtractorInput, reason: string): ExtractionResult {
  return {
    isRelevant:           false,
    category:             'MARKET_REPORT',
    transactionType:      'INFORMATIONAL',
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
    extractedTitle:       input.subject ?? '(market report)',
    extractedSummary:     'Extraction failed — requires manual review.',
    classificationReason: reason,
    confidenceScore:      0,
    flagReasons:          ['schema_validation_failed'],
    processingStatus:     'needs_review',
  }
}

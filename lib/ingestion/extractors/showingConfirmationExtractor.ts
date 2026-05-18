// Handles: SHOWING_CONFIRMATION — confirmed showing appointment details
import OpenAI from 'openai'
import { z } from 'zod'
import type { ExtractorInput, ExtractionResult } from '../types'

export const EXTRACTOR_VERSION = '1.0'

const ShowingItemSchema = z.object({
  address:          z.string().nullable(),
  neighborhood:     z.string().nullable(),
  borough:          z.string().nullable(),
  confirmedDate:    z.string().nullable(),   // "YYYY-MM-DD"
  confirmedTime:    z.string().nullable(),   // "HH:MM" 24h or "2:00 PM"
  confirmingAgent:  z.string().nullable(),   // agent who confirmed the showing
  confirmingEmail:  z.string().nullable(),
  brokerage:        z.string().nullable(),
  attendees:        z.string().nullable(),   // who is attending if stated
  propertyType:     z.string().nullable(),
  beds:             z.number().nullable(),
  price:            z.number().nullable(),   // listing price if mentioned
  extractedTitle:   z.string().nullish().transform(v => v ?? ''),
  extractedSummary: z.string().nullish().transform(v => v ?? ''),
  classificationReason: z.string().nullish().transform(v => v ?? ''),
  confidenceScore:  z.number().min(0).max(1).nullish().transform(v => v ?? 0.7),
})

const ResponseSchema = z.object({
  showings: z.array(ShowingItemSchema),
})

const SYSTEM_PROMPT = `You are a NYC real estate showing confirmation extractor. Extract structured data from emails confirming a property showing appointment.

SHOWING CONFIRMATION signals:
- "Confirmed for [date/time]"
- "Your showing at [address] is confirmed"
- "Appointment confirmed" with a property address
- Reply from an agent confirming a scheduled tour

EXTRACTION RULES:
- address: the property being shown (full address with unit if given)
- confirmedDate: the date of the showing as "YYYY-MM-DD"
- confirmedTime: the time of the showing (preserve the original format, e.g. "2:00 PM" or "14:00")
- confirmingAgent: the name of the agent who sent the confirmation
- confirmingEmail: their email address
- attendees: any mentioned attendees (buyer name, agent name, etc.) or null
- beds/price: the listing's details if mentioned in the email
- extractedTitle: short title like "Showing Confirmed — 317 East 18th St"
- extractedSummary: one sentence with date, time, and address
- confidenceScore: 0.9+ if date + address clear, 0.7–0.9 probable

Return ONLY valid JSON: { "showings": [...] }`

function buildPrompt(input: ExtractorInput): string {
  const body = input.fullBody
    ? `\nFull Body:\n${input.fullBody.slice(0, 6000)}`
    : (input.bodyPreview ? `\nPreview: ${input.bodyPreview}` : '')
  const att = input.attachmentText
    ? `\n\nAttachment:\n${input.attachmentText.slice(0, 4000)}`
    : ''
  return `Extract showing confirmation details from this email:

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

  if (validated.data.showings.length === 0) {
    return [schemaFailed(input, 'Extractor returned empty showings array')]
  }

  return validated.data.showings.map(s => {
    // Combine date + time into availabilityDate for storage
    const availabilityDate = s.confirmedDate
      ? (s.confirmedTime ? `${s.confirmedDate}T${s.confirmedTime}` : s.confirmedDate)
      : null

    return {
      isRelevant:           true,
      category:             'SHOWING_CONFIRMATION',
      transactionType:      'UNKNOWN',
      propertyType:         s.propertyType ?? null,
      address:              s.address ?? null,
      neighborhood:         s.neighborhood ?? null,
      borough:              s.borough ?? null,
      city:                 'New York',
      state:                'NY',
      zip:                  null,
      price:                s.price ?? null,
      minPrice:             null,
      maxPrice:             null,
      beds:                 s.beds ?? null,
      baths:                null,
      units:                null,
      squareFeet:           null,
      availabilityDate,
      sourceAgentName:      s.confirmingAgent ?? input.senderName ?? null,
      sourceAgentEmail:     s.confirmingEmail ?? input.senderEmail ?? null,
      sourceBrokerage:      s.brokerage ?? null,
      clientSide:           null,
      status:               'confirmed',
      extractedTitle:       s.extractedTitle,
      extractedSummary:     s.extractedSummary,
      classificationReason: s.classificationReason,
      confidenceScore:      s.confidenceScore,
    }
  })
}

function schemaFailed(input: ExtractorInput, reason: string): ExtractionResult {
  return {
    isRelevant:           true,
    category:             'SHOWING_CONFIRMATION',
    transactionType:      'UNKNOWN',
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
    extractedTitle:       input.subject ?? '(showing confirmation)',
    extractedSummary:     'Extraction failed — requires manual review.',
    classificationReason: reason,
    confidenceScore:      0,
    flagReasons:          ['schema_validation_failed'],
    processingStatus:     'needs_review',
  }
}

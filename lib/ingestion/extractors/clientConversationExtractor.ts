// Handles: CLIENT_CONVERSATION — emails that are direct client conversations, not broadcast listings
import OpenAI from 'openai'
import { z } from 'zod'
import type { ExtractorInput, ExtractionResult } from '../types'
import { safeConversationText, leadFallbackTitle, mentionsPersonalCircumstances } from '../../extraction/personalCircumstances'

export const EXTRACTOR_VERSION = '1.0'

const ConversationItemSchema = z.object({
  clientName:       z.string().nullable(),
  clientEmail:      z.string().nullable(),
  agentName:        z.string().nullable(),
  agentEmail:       z.string().nullable(),
  brokerage:        z.string().nullable(),
  clientSide:       z.string().nullable(),   // "buyer", "seller", "renter", "landlord", "unknown"
  neighborhood:     z.string().nullable(),   // if they mentioned a target area
  borough:          z.string().nullable(),
  price:            z.number().nullable(),   // if a price/budget was mentioned
  beds:             z.number().nullable(),   // if bed count was mentioned
  propertyType:     z.string().nullable(),
  address:          z.string().nullable(),   // if a specific property was discussed
  keyTopics:        z.string().nullable(),   // brief summary of what was discussed
  nextStep:         z.string().nullable(),   // any follow-up action mentioned
  extractedTitle:   z.string().nullish().transform(v => v ?? ''),
  extractedSummary: z.string().nullish().transform(v => v ?? ''),
  classificationReason: z.string().nullish().transform(v => v ?? ''),
  confidenceScore:  z.number().min(0).max(1).nullish().transform(v => v ?? 0.7),
})

const ResponseSchema = z.object({
  conversations: z.array(ConversationItemSchema),
})

const SYSTEM_PROMPT = `You are a NYC real estate conversation extractor. Extract structured data from direct client or agent conversations — NOT broadcast listing emails.

CLIENT CONVERSATION signals:
- Direct back-and-forth with a client about their needs or a specific property
- An agent referring a specific client with detailed background
- Follow-up emails about a showing, offer, or negotiation
- An introduction email from one agent to another about a mutual client

EXTRACTION RULES:
- clientName: the name of the client (buyer, seller, renter, etc.) — NOT the sending agent
- clientEmail: the client's email if given
- agentName: the sending agent's name
- agentEmail: the sending agent's email
- clientSide: what role is the client? "buyer", "seller", "renter", "landlord", or "unknown"
- neighborhood/borough: where are they looking or what area is discussed?
- price: any budget or price figure mentioned as a number
- beds: any bed count mentioned
- address: if a specific property address came up
- keyTopics: brief summary of the main topics discussed (2–3 phrases max)
- nextStep: any explicit follow-up action or next step mentioned
- extractedSummary: 1–2 sentences capturing who this is and what they need
- Never record personal circumstances (estate, probate, inheritance, divorce, death, illness, family matters) of a seller, landlord or property owner: leave them out of every field
- confidenceScore: 0.9+ clear, 0.7–0.9 probable

Return ONLY valid JSON: { "conversations": [...] }`

function buildPrompt(input: ExtractorInput): string {
  const body = input.fullBody
    ? `\nFull Body:\n${input.fullBody.slice(0, 6000)}`
    : (input.bodyPreview ? `\nPreview: ${input.bodyPreview}` : '')
  const att = input.attachmentText
    ? `\n\nAttachment:\n${input.attachmentText.slice(0, 4000)}`
    : ''
  return `Extract conversation context from this email:

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

  if (validated.data.conversations.length === 0) {
    return [schemaFailed(input, 'Extractor returned empty conversations array')]
  }

  return validated.data.conversations.map(c => ({
    isRelevant:           true,
    category:             'CLIENT_CONVERSATION',
    transactionType:      'UNKNOWN',
    propertyType:         c.propertyType ?? null,
    address:              c.address ?? null,
    neighborhood:         c.neighborhood ?? null,
    borough:              c.borough ?? null,
    city:                 'New York',
    state:                'NY',
    zip:                  null,
    price:                c.price ?? null,
    minPrice:             null,
    maxPrice:             null,
    beds:                 c.beds ?? null,
    baths:                null,
    units:                null,
    squareFeet:           null,
    availabilityDate:     null,
    sourceAgentName:      c.agentName ?? input.senderName ?? null,
    sourceAgentEmail:     c.agentEmail ?? input.senderEmail ?? null,
    sourceBrokerage:      c.brokerage ?? null,
    clientSide:           c.clientSide ?? null,
    status:               null,
    // Brief 41.1: a seller's or landlord's conversation (or one whose side isn't
    // clear) never stores their personal circumstances (the same helper as V2).
    ...(({ title, summary, reason }) => ({ extractedTitle: title, extractedSummary: summary, classificationReason: reason }))(
      safeConversationText({
        clientSide: c.clientSide,
        title: c.extractedTitle,
        summary: [c.extractedSummary, c.nextStep ? `Next: ${c.nextStep}` : null].filter(Boolean).join(' '),
        reason: c.classificationReason,
        fallbackTitle: leadFallbackTitle('CLIENT_CONVERSATION', c.address ?? c.neighborhood),
      }),
    ),
    confidenceScore:      c.confidenceScore,
  }))
}

function schemaFailed(input: ExtractorInput, reason: string): ExtractionResult {
  return {
    isRelevant:           true,
    category:             'CLIENT_CONVERSATION',
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
    extractedTitle:       input.subject && !mentionsPersonalCircumstances(input.subject) ? input.subject : '(client conversation)',
    extractedSummary:     'Extraction failed — requires manual review.',
    classificationReason: reason,
    confidenceScore:      0,
    flagReasons:          ['schema_validation_failed'],
    processingStatus:     'needs_review',
  }
}

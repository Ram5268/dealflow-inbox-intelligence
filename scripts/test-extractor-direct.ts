// Test saleListingExtractor directly to see raw GPT output
import { prisma } from '../lib/prisma'
import OpenAI from 'openai'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const SYSTEM_PROMPT = `You are a NYC real estate sale listing extractor. Extract structured data from sale-related emails.

SUBJECT LINE IS KEY: NYC broker blast emails often put the full listing details in the subject
(address, price, beds, baths) while the body is boilerplate HTML ("Trouble viewing this email...").
ALWAYS extract from the subject if it contains listing details, even if the body is empty or boilerplate.
Example: Subject "JUST LISTED AT 317 E 18TH ST #4A - 1 BED 1 BATH - ASKING $650,000"
→ address="317 East 18th Street #4A", beds=1, baths=1, price=650000, category=ACTIVE_SALE_LISTING

EXTRACTION RULES:
- Extract from subject line first, then body, then attachments.
- price: number only (e.g. 650000, not "$650,000")
- beds/baths: number (e.g. 2, not "2BR")
- Return at least one entry if any listing details are found.

Return ONLY valid JSON: { "listings": [{ "address": string|null, "neighborhood": string|null, "borough": string|null, "city": string|null, "state": string|null, "zip": string|null, "price": number|null, "beds": number|null, "baths": number|null, "squareFeet": number|null, "propertyType": string|null, "availabilityDate": string|null, "status": string|null, "category": string, "transactionType": string, "sourceAgentName": string|null, "sourceAgentEmail": string|null, "sourceBrokerage": string|null, "extractedTitle": string, "extractedSummary": string, "classificationReason": string, "confidenceScore": number }] }`

async function main() {
  const email = await prisma.rawEmail.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { subject: true, senderName: true, senderEmail: true, bodyContent: true }
  })
  if (!email) return

  const body = email.bodyContent ? `\nBody: ${email.bodyContent.slice(0, 500)}` : ''
  const userPrompt = `Extract all sale listings from this email:\n\nSubject: ${email.subject}\nFrom: ${email.senderName} <${email.senderEmail}>${body}`

  console.log('Sending to GPT...\n')
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0,
    max_tokens: 2048,
    response_format: { type: 'json_object' }
  })
  console.log('GPT response:')
  console.log(res.choices[0].message.content)
}

main().catch(console.error).finally(() => prisma.$disconnect())

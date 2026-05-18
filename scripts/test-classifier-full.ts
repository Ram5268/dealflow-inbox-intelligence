// Test the actual sourceClassifier with the real system prompt on the most recent email
import { prisma } from '../lib/prisma'
import OpenAI from 'openai'

// Copy the exact system prompt from sourceClassifier.ts to test directly
const SYSTEM_PROMPT = `You are a real estate email classifier for a NYC Douglas Elliman agent.

Your ONLY job: determine the category of this email and whether it needs deep extraction.

SUBJECT PRIORITY RULE — critical:
The subject line is the most reliable signal. If it contains any of these, NEVER classify as NOISE:
- Price: "$XXX,XXX" or "$X.XM" or "asking" or "priced at"
- Beds/baths: "1 bed", "2BR", "3 bed/2 bath", "studio"
- Listing signals: "just listed", "new listing", "for sale", "for rent", "available", "price drop", "back on market", "off market", "coming soon", "open house"
- Address: a number followed by a street name (e.g. "123 Main St")
- ISO signals: "ISO", "buyer looking", "client needs", "seeking"

CATEGORIES:
  ACTIVE_SALE_LISTING, RENTAL_LISTING, BUYER_ISO, OFF_MARKET_SALE, NOISE

NOISE check: Set needsDeepExtract=false ONLY when clearly not real estate relevant.
When in doubt with a real estate subject line, classify as the appropriate category.

Return ONLY valid JSON, no markdown:
{
  "category": string,
  "confidence": number,
  "needsDeepExtract": boolean,
  "isMultiListing": boolean
}`

async function main() {
  const email = await prisma.rawEmail.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { subject: true, senderName: true, bodyPreview: true, bodyContent: true }
  })
  if (!email) return

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const userPrompt = `Subject: ${email.subject}\nFrom: ${email.senderName}\n(Body not useful — classify from subject only)`

  console.log('User prompt:', userPrompt)
  console.log()

  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0,
    max_tokens: 120,
    response_format: { type: 'json_object' }
  })
  console.log('GPT says:', res.choices[0].message.content)
}

main().catch(console.error).finally(() => prisma.$disconnect())

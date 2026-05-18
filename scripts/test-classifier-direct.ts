import OpenAI from 'openai'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const SYSTEM = `You are a real estate email classifier.

SUBJECT PRIORITY RULE: If the subject contains price, beds/baths, listing signals like 'just listed', 'for sale', 'for rent', or an address — NEVER classify as NOISE.

Return ONLY valid JSON: { "category": string, "confidence": number, "needsDeepExtract": boolean, "isMultiListing": boolean }

Categories: ACTIVE_SALE_LISTING, RENTAL_LISTING, BUYER_ISO, OFF_MARKET_SALE, NOISE (only for truly irrelevant emails)`

async function main() {
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'Subject: *JUST LISTED AT 317 EAST 18TH ST #4A - SOUTH FACING 1 BED 1 BATH - ELEVATOR BUILDING ASKING $650,000\nFrom: Joshua Lieberman\n(Body not useful — classify from subject only)' }
    ],
    temperature: 0,
    max_tokens: 120,
    response_format: { type: 'json_object' }
  })
  console.log('GPT response:', res.choices[0].message.content)
}

main().catch(console.error)

// LIVE TEST: OpenAI strict JSON schema mode vs json_object baseline.
// Reads 3 known-failing samples from /tmp/strict-samples.json,
// re-runs both modes side-by-side, parses with the same Zod schemas
// the production extractors use, and reports deltas.
import 'dotenv/config'
import { readFileSync } from 'fs'
import OpenAI from 'openai'
import { z } from 'zod'

const samples = JSON.parse(readFileSync('/tmp/strict-samples.json', 'utf8'))
const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) throw new Error('Missing OPENAI_API_KEY')
const client = new OpenAI({ apiKey })

// ───────── Zod schemas (copied verbatim from production extractors) ─────────
const SaleListingItemSchema = z.object({
  address:          z.string().nullable(),
  neighborhood:     z.string().nullable(),
  borough:          z.string().nullable(),
  city:             z.string().nullable(),
  state:            z.string().nullable(),
  zip:              z.string().nullable(),
  price:            z.number().nullable(),
  beds:             z.number().nullable(),
  baths:            z.number().nullable(),
  squareFeet:       z.number().nullable(),
  units:            z.number().nullable().optional(),
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
const SaleListingResponseSchema = z.object({ listings: z.array(SaleListingItemSchema) })

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
  units:            z.number().nullable().optional(),
  price:            z.number().nullable(),
  minPrice:         z.number().nullable(),
  maxPrice:         z.number().nullable(),
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
const DevResponseSchema = z.object({ listings: z.array(DevItemSchema) })

// ───────── Hand-translated OpenAI strict JSON schemas ─────────
// Rules: every property listed in `required`, additionalProperties:false,
// nullable via union type, enums for `category`.
function buildSaleStrictSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      listings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            address:              { type: ['string', 'null'] },
            neighborhood:         { type: ['string', 'null'] },
            borough:               { type: ['string', 'null'] },
            city:                 { type: ['string', 'null'] },
            state:                { type: ['string', 'null'] },
            zip:                  { type: ['string', 'null'] },
            price:                { type: ['number', 'null'] },
            beds:                 { type: ['number', 'null'] },
            baths:                { type: ['number', 'null'] },
            squareFeet:           { type: ['number', 'null'] },
            units:                { type: ['number', 'null'] },
            propertyType:         { type: ['string', 'null'] },
            availabilityDate:     { type: ['string', 'null'] },
            status:               { type: ['string', 'null'] },
            category: {
              type: 'string',
              enum: ['ACTIVE_SALE_LISTING','OFF_MARKET_SALE','BACK_ON_MARKET','PRICE_DROP','OPEN_HOUSE'],
            },
            transactionType:      { type: ['string', 'null'] },
            sourceAgentName:      { type: ['string', 'null'] },
            sourceAgentEmail:     { type: ['string', 'null'] },
            sourceBrokerage:      { type: ['string', 'null'] },
            extractedTitle:       { type: 'string' },
            extractedSummary:     { type: 'string' },
            classificationReason: { type: 'string' },
            confidenceScore:      { type: 'number', minimum: 0, maximum: 1 },
          },
          required: [
            'address','neighborhood','borough','city','state','zip','price','beds','baths',
            'squareFeet','units','propertyType','availabilityDate','status','category',
            'transactionType','sourceAgentName','sourceAgentEmail','sourceBrokerage',
            'extractedTitle','extractedSummary','classificationReason','confidenceScore',
          ],
        },
      },
    },
    required: ['listings'],
  }
}

function buildDevStrictSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      listings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            address:              { type: ['string', 'null'] },
            neighborhood:         { type: ['string', 'null'] },
            borough:              { type: ['string', 'null'] },
            city:                 { type: ['string', 'null'] },
            state:                { type: ['string', 'null'] },
            zip:                  { type: ['string', 'null'] },
            beds:                 { type: ['number', 'null'] },
            baths:                { type: ['number', 'null'] },
            squareFeet:           { type: ['number', 'null'] },
            units:                { type: ['number', 'null'] },
            price:                { type: ['number', 'null'] },
            minPrice:             { type: ['number', 'null'] },
            maxPrice:             { type: ['number', 'null'] },
            propertyType:         { type: ['string', 'null'] },
            availabilityDate:     { type: ['string', 'null'] },
            status:               { type: ['string', 'null'] },
            category: {
              type: 'string',
              enum: ['DEVELOPMENT_INVENTORY','COMING_SOON_DEVELOPMENT','SPONSOR_UNIT'],
            },
            transactionType:      { type: ['string', 'null'] },
            sourceAgentName:      { type: ['string', 'null'] },
            sourceAgentEmail:     { type: ['string', 'null'] },
            sourceBrokerage:      { type: ['string', 'null'] },
            extractedTitle:       { type: 'string' },
            extractedSummary:     { type: 'string' },
            classificationReason: { type: 'string' },
            confidenceScore:      { type: 'number', minimum: 0, maximum: 1 },
          },
          required: [
            'address','neighborhood','borough','city','state','zip','beds','baths','squareFeet','units',
            'price','minPrice','maxPrice','propertyType','availabilityDate','status','category',
            'transactionType','sourceAgentName','sourceAgentEmail','sourceBrokerage',
            'extractedTitle','extractedSummary','classificationReason','confidenceScore',
          ],
        },
      },
    },
    required: ['listings'],
  }
}

// ───────── Prompts (copied verbatim from production extractors) ─────────
const SALE_SYSTEM_PROMPT = `You are a NYC real estate sale listing extractor. Extract structured data from sale-related emails.

CATEGORIES to assign (pick the most accurate one):
- ACTIVE_SALE_LISTING — currently listed for sale publicly
- OFF_MARKET_SALE — private/pocket listing, not on public MLS. NOTE: "Exclusive listing" = standard MLS, NOT off-market.
- BACK_ON_MARKET — previously listed, went off, now back
- PRICE_DROP — existing listing with a price reduction
- OPEN_HOUSE — open house or broker preview announcement

SUBJECT LINE IS KEY: NYC broker blast emails often put the full listing details in the subject
(address, price, beds, baths) while the body is boilerplate HTML ("Trouble viewing this email...").
ALWAYS extract from the subject if it contains listing details, even if the body is empty or boilerplate.
Example: Subject "JUST LISTED AT 317 E 18TH ST #4A - 1 BED 1 BATH - ASKING $650,000"
→ address="317 East 18th Street #4A", beds=1, baths=1, price=650000, category=ACTIVE_SALE_LISTING

MULTI-LISTING: If the email contains multiple properties, extract each as a separate entry.

EXTRACTION RULES:
- Extract from subject line first, then body, then attachments.
- Never invent address, price, beds, baths, or neighborhood. Use null if not stated anywhere.
- price: number only (e.g. 650000, not "$650,000")
- beds/baths: number (e.g. 2, not "2BR")
- availabilityDate: ISO date string "YYYY-MM-DD" or null
- propertyType: condo, co-op, townhouse, multi-family, single-family, land, commercial
- transactionType: always "SALE"
- confidenceScore: 0.9+ unambiguous, 0.7-0.9 probable, 0.5-0.7 ambiguous

Return ONLY valid JSON: { "listings": [...] }
If you can extract any listing details (even just from the subject), always return at least one entry.`

const DEV_SYSTEM_PROMPT = `You are a NYC new development real estate extractor. Extract structured data from new development building announcements and sponsor unit emails.

CATEGORIES:
- DEVELOPMENT_INVENTORY — building IS actively selling NOW: "Now Selling", "Sales Gallery Open", "Now Available", "Grand Opening", current pricing, "immediate occupancy", "last remaining units"
- COMING_SOON_DEVELOPMENT — building NOT yet on market: "Coming Soon", "pre-launch", "VIP preview", "now accepting reservations", "estimated closings YYYY", "anticipated completion", pricing is future/indicative, no sales gallery open yet
- SPONSOR_UNIT — single specific sponsor unit with its own unit number and price (not a full building announcement)

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

function buildUserPrompt(sample, kind) {
  const fullBody = sample.bodyContent ?? ''
  const body = fullBody
    ? `\nFull Body:\n${fullBody.slice(0, 8000)}`
    : (sample.bodyPreview ? `\nPreview: ${sample.bodyPreview}` : '')
  const att = sample.attachmentsText
    ? `\n\nAttachment:\n${sample.attachmentsText.slice(0, 6000)}`
    : ''
  const lead = kind === 'sale'
    ? 'Extract all sale listings from this email:'
    : 'Extract all new development listings from this email:'
  return `${lead}

Subject: ${sample.subject}
From: ${sample.senderName ?? 'Unknown'} <${sample.senderEmail ?? ''}>
Attachments: ${(sample.attachmentNames ?? []).join(', ') || 'none'}${body}${att}`
}

async function runMode({ sample, kind, mode }) {
  const systemPrompt = kind === 'sale' ? SALE_SYSTEM_PROMPT : DEV_SYSTEM_PROMPT
  const userPrompt = buildUserPrompt(sample, kind)
  const zodSchema = kind === 'sale' ? SaleListingResponseSchema : DevResponseSchema

  const req = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    temperature: 0,
    max_tokens: 2048,
  }
  if (mode === 'json_object') {
    req.response_format = { type: 'json_object' }
  } else if (mode === 'json_schema') {
    const schema = kind === 'sale' ? buildSaleStrictSchema() : buildDevStrictSchema()
    req.response_format = {
      type: 'json_schema',
      json_schema: { name: 'extraction', strict: true, schema },
    }
  }

  const t0 = Date.now()
  let raw, apiError = null
  try {
    const res = await client.chat.completions.create(req)
    raw = res.choices[0].message.content ?? '{}'
    var usage = res.usage
  } catch (err) {
    apiError = err?.message ?? String(err)
    raw = '{}'
    var usage = null
  }
  const ms = Date.now() - t0

  let parsed, parseErr = null
  try { parsed = JSON.parse(raw) } catch (e) { parseErr = 'JSON.parse failed: ' + e.message }

  const z = zodSchema.safeParse(parsed ?? {})
  const zodOk = z.success
  const zodIssue = z.success ? null : (z.error.issues[0]?.path?.join('.') + ': ' + z.error.issues[0]?.message)
  const listings = zodOk ? z.data.listings : []

  return {
    mode, ms, apiError, parseErr, zodOk, zodIssue,
    listingsCount: listings.length,
    firstListing: listings[0] ?? null,
    rawLen: raw.length,
    rawSnippet: raw.slice(0, 1200),
    usage,
  }
}

const results = []
for (const sample of samples) {
  const kind = sample.category === 'DEVELOPMENT_INVENTORY' ? 'dev' : 'sale'
  console.log(`\n=== ${sample.oppId} (${sample.category}) — ${sample.subject?.slice(0,70)}`)
  const baseline = await runMode({ sample, kind, mode: 'json_object' })
  console.log('  baseline:', {
    ok: baseline.zodOk, listings: baseline.listingsCount,
    issue: baseline.zodIssue, ms: baseline.ms,
    err: baseline.apiError, in: baseline.usage?.prompt_tokens, out: baseline.usage?.completion_tokens,
  })
  const strict = await runMode({ sample, kind, mode: 'json_schema' })
  console.log('  strict:  ', {
    ok: strict.zodOk, listings: strict.listingsCount,
    issue: strict.zodIssue, ms: strict.ms,
    err: strict.apiError, in: strict.usage?.prompt_tokens, out: strict.usage?.completion_tokens,
  })
  results.push({ sample: { id: sample.oppId, cat: sample.category, subj: sample.subject }, baseline, strict })
}

// Summary
console.log('\n========== SUMMARY ==========')
let baseOk = 0, strictOk = 0, fixed = 0, regressed = 0
let inTotal = 0, outTotal = 0
for (const r of results) {
  if (r.baseline.zodOk) baseOk++
  if (r.strict.zodOk)   strictOk++
  if (!r.baseline.zodOk && r.strict.zodOk) fixed++
  if (r.baseline.zodOk && !r.strict.zodOk) regressed++
  inTotal  += (r.baseline.usage?.prompt_tokens ?? 0) + (r.strict.usage?.prompt_tokens ?? 0)
  outTotal += (r.baseline.usage?.completion_tokens ?? 0) + (r.strict.usage?.completion_tokens ?? 0)
}
console.log({ baseline_pass: baseOk, strict_pass: strictOk, fixed_by_strict: fixed, regressed_by_strict: regressed, of_total: results.length })
const costUsd = (inTotal/1e6)*0.15 + (outTotal/1e6)*0.6
console.log({ total_in_tokens: inTotal, total_out_tokens: outTotal, est_cost_usd: costUsd.toFixed(5) })

// Per-sample detail
for (const r of results) {
  console.log('\n--- DETAIL', r.sample.id, '|', r.sample.cat, '|', r.sample.subj?.slice(0,60))
  console.log('  baseline.zodOk =', r.baseline.zodOk, '| listings =', r.baseline.listingsCount, '| issue =', r.baseline.zodIssue)
  console.log('  strict.zodOk   =', r.strict.zodOk,   '| listings =', r.strict.listingsCount,   '| issue =', r.strict.zodIssue)
  if (r.strict.zodOk && r.strict.firstListing) {
    const f = r.strict.firstListing
    console.log('  strict.first   = addr=%s, price=%s, beds=%s, baths=%s, cat=%s, title=%s',
      f.address, f.price, f.beds, f.baths, f.category, (f.extractedTitle||'').slice(0,60))
  }
  if (r.baseline.zodOk && r.baseline.firstListing) {
    const f = r.baseline.firstListing
    console.log('  baseline.first = addr=%s, price=%s, beds=%s, baths=%s, cat=%s',
      f.address, f.price, f.beds, f.baths, f.category)
  }
  if (!r.baseline.zodOk) {
    console.log('  baseline raw (first 600 chars):', r.baseline.rawSnippet.slice(0, 600))
  }
  if (!r.strict.zodOk) {
    console.log('  strict raw (first 600 chars):', r.strict.rawSnippet.slice(0, 600))
  }
}

import { writeFileSync } from 'fs'
writeFileSync('/tmp/strict-results.json', JSON.stringify(results, null, 2))
console.log('\nSaved /tmp/strict-results.json')

// LIVE TEST: Claude Sonnet tool_use mode vs gpt-4o-mini json_object baseline
// Picks 3 failing emails (each had Zod failure under V1 extractor) and re-runs
// extraction with Claude Sonnet using tool_use forcing.
//
// Per email, output:
//  - baseline (gpt-4o-mini json_object): raw JSON, Zod result, stored opportunity row
//  - sonnet (claude-sonnet-4-6 tool_use): tool input, Zod result, qualitative compare
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'

const SAMPLE_OPP_IDS = [
  'cmpxba6tw00b4h68ojg78c9cy', // RENTAL_LISTING — Yorkshire/Lexington Towers hotsheet
  'cmpxb6eed008xh68ocg2mb5v0', // BUYER_ISO — TriBeCa/Hudson Square 3 Bed ~$5M
  'cmpxb8l3r00aeh68oeylvie2n', // ACTIVE_SALE_LISTING — Beekman Candela Jewel Studio OH
]

// ── V1 schemas (mirror lib/ingestion/extractors/*) ────────────────────────────
const SaleListingItem = z.object({
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
const SaleResponse = z.object({ listings: z.array(SaleListingItem) })

const RentalListingItem = SaleListingItem.extend({
  minPrice: z.number().nullable(),
  maxPrice: z.number().nullable(),
})
const RentalResponse = z.object({ listings: z.array(RentalListingItem) })

const ISOItem = z.object({
  neighborhoods:    z.array(z.string()).default([]),
  borough:          z.string().nullable(),
  minPrice:         z.number().nullable(),
  maxPrice:         z.number().nullable(),
  minBeds:          z.number().int().nullable(),
  maxBeds:          z.number().int().nullable(),
  beds:             z.number().nullable(),
  propertyTypes:    z.array(z.string()).default([]),
  mustHaves:        z.string().nullable(),
  dealbreakers:     z.string().nullable(),
  timeline:         z.string().nullable(),
  sourceAgentName:  z.string().nullable(),
  sourceAgentEmail: z.string().nullable(),
  sourceBrokerage:  z.string().nullable(),
  clientSide:       z.string().nullable(),
  extractedTitle:   z.string(),
  extractedSummary: z.string(),
  classificationReason: z.string(),
  confidenceScore:  z.number().min(0).max(1),
})
const ISOResponse = z.object({ isos: z.array(ISOItem) })

// ── System prompts (verbatim from V1 extractors) ──────────────────────────────
const SALE_SYSTEM = `You are a NYC real estate sale listing extractor. Extract structured data from sale-related emails.

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

const RENTAL_SYSTEM = `You are a NYC real estate rental listing extractor. Extract structured data from rental emails.

CATEGORIES:
- RENTAL_LISTING — currently listed for rent
- COMING_SOON_RENTAL — rental becoming available soon (future move-in date, not yet on market)

SUBJECT LINE IS KEY: Broker emails often put the key listing details in the subject while the body
is boilerplate. Always extract from the subject first if it contains rental details.

MULTI-LISTING: If the email has multiple units/apartments, extract each as a separate entry.
Example: availability reports with "1BR $3,500 / 2BR $4,800" → two entries.

EXTRACTION RULES:
- Extract from subject line first, then body, then attachments.
- Never invent address, rent, or beds. Use null if not stated anywhere.
- Return at least one entry if any listing details are found (even just from the subject).
- price: monthly rent as a number (e.g. 3500, not "$3,500/mo"). Use for exact rent.
- minPrice/maxPrice: use when a range is given (e.g. "$3,500-$4,000/mo")
- beds: number (2, not "2BR"). Studios = 0.
- availabilityDate: move-in date as "YYYY-MM-DD" or null
- propertyType: apartment, condo, co-op, townhouse, loft, room, etc.
- transactionType: always "RENTAL"
- category: RENTAL_LISTING if available now or already on market; COMING_SOON_RENTAL if future availability
- confidenceScore: 0.9+ unambiguous, 0.7-0.9 probable

Return ONLY valid JSON: { "listings": [...] }`

const ISO_SYSTEM = `You are a NYC real estate buyer ISO extractor. Extract structured buyer search criteria from agent broadcasts.

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

// ── Tool input_schemas (JSON Schema) — mirror Zod ────────────────────────────
const SALE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    listings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          address:          { type: ['string', 'null'] },
          neighborhood:     { type: ['string', 'null'] },
          borough:          { type: ['string', 'null'] },
          city:             { type: ['string', 'null'] },
          state:            { type: ['string', 'null'] },
          zip:              { type: ['string', 'null'] },
          price:            { type: ['number', 'null'] },
          beds:             { type: ['number', 'null'] },
          baths:            { type: ['number', 'null'] },
          squareFeet:       { type: ['number', 'null'] },
          units:            { type: ['number', 'null'] },
          propertyType:     { type: ['string', 'null'] },
          availabilityDate: { type: ['string', 'null'], description: 'ISO YYYY-MM-DD or null' },
          status:           { type: ['string', 'null'] },
          category:         { type: 'string', enum: ['ACTIVE_SALE_LISTING','OFF_MARKET_SALE','BACK_ON_MARKET','PRICE_DROP','OPEN_HOUSE'] },
          transactionType:  { type: 'string', enum: ['SALE'] },
          sourceAgentName:  { type: ['string', 'null'] },
          sourceAgentEmail: { type: ['string', 'null'] },
          sourceBrokerage:  { type: ['string', 'null'] },
          extractedTitle:   { type: 'string' },
          extractedSummary: { type: 'string' },
          classificationReason: { type: 'string' },
          confidenceScore:  { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['address','neighborhood','borough','city','state','zip','price','beds','baths','squareFeet','propertyType','availabilityDate','status','category','transactionType','sourceAgentName','sourceAgentEmail','sourceBrokerage','extractedTitle','extractedSummary','classificationReason','confidenceScore'],
      },
    },
  },
  required: ['listings'],
}

const RENTAL_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    listings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          address:          { type: ['string', 'null'] },
          neighborhood:     { type: ['string', 'null'] },
          borough:          { type: ['string', 'null'] },
          city:             { type: ['string', 'null'] },
          state:            { type: ['string', 'null'] },
          zip:              { type: ['string', 'null'] },
          price:            { type: ['number', 'null'] },
          minPrice:         { type: ['number', 'null'] },
          maxPrice:         { type: ['number', 'null'] },
          beds:             { type: ['number', 'null'] },
          baths:            { type: ['number', 'null'] },
          squareFeet:       { type: ['number', 'null'] },
          units:            { type: ['number', 'null'] },
          propertyType:     { type: ['string', 'null'] },
          availabilityDate: { type: ['string', 'null'] },
          status:           { type: ['string', 'null'] },
          category:         { type: 'string', enum: ['RENTAL_LISTING','COMING_SOON_RENTAL'] },
          transactionType:  { type: 'string', enum: ['RENTAL'] },
          sourceAgentName:  { type: ['string', 'null'] },
          sourceAgentEmail: { type: ['string', 'null'] },
          sourceBrokerage:  { type: ['string', 'null'] },
          extractedTitle:   { type: 'string' },
          extractedSummary: { type: 'string' },
          classificationReason: { type: 'string' },
          confidenceScore:  { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['address','neighborhood','borough','city','state','zip','price','minPrice','maxPrice','beds','baths','squareFeet','propertyType','availabilityDate','status','category','transactionType','sourceAgentName','sourceAgentEmail','sourceBrokerage','extractedTitle','extractedSummary','classificationReason','confidenceScore'],
      },
    },
  },
  required: ['listings'],
}

const ISO_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    isos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          neighborhoods:    { type: 'array', items: { type: 'string' } },
          borough:          { type: ['string', 'null'] },
          minPrice:         { type: ['number', 'null'] },
          maxPrice:         { type: ['number', 'null'] },
          minBeds:          { type: ['integer', 'null'] },
          maxBeds:          { type: ['integer', 'null'] },
          beds:             { type: ['number', 'null'] },
          propertyTypes:    { type: 'array', items: { type: 'string' } },
          mustHaves:        { type: ['string', 'null'] },
          dealbreakers:     { type: ['string', 'null'] },
          timeline:         { type: ['string', 'null'] },
          sourceAgentName:  { type: ['string', 'null'] },
          sourceAgentEmail: { type: ['string', 'null'] },
          sourceBrokerage:  { type: ['string', 'null'] },
          clientSide:       { type: ['string', 'null'] },
          extractedTitle:   { type: 'string' },
          extractedSummary: { type: 'string' },
          classificationReason: { type: 'string' },
          confidenceScore:  { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['neighborhoods','borough','minPrice','maxPrice','minBeds','maxBeds','beds','propertyTypes','mustHaves','dealbreakers','timeline','sourceAgentName','sourceAgentEmail','sourceBrokerage','clientSide','extractedTitle','extractedSummary','classificationReason','confidenceScore'],
      },
    },
  },
  required: ['isos'],
}

function buildPromptListing(input: {
  subject: string; senderName: string | null; senderEmail: string | null;
  attachmentNames: string[]; fullBody: string | null; attachmentText: string | null;
  bodyPreview: string | null;
}, kind: 'sale' | 'rental') {
  const body = input.fullBody
    ? `\nFull Body:\n${input.fullBody.slice(0, 8000)}`
    : (input.bodyPreview ? `\nPreview: ${input.bodyPreview}` : '')
  const att = input.attachmentText
    ? `\n\nAttachment:\n${input.attachmentText.slice(0, 6000)}`
    : ''
  const verb = kind === 'sale' ? 'sale listings' : 'rental listings'
  return `Extract all ${verb} from this email:

Subject: ${input.subject}
From: ${input.senderName ?? 'Unknown'} <${input.senderEmail ?? ''}>
Attachments: ${input.attachmentNames.join(', ') || 'none'}${body}${att}`
}

function buildPromptISO(input: {
  subject: string; senderName: string | null; senderEmail: string | null;
  attachmentNames: string[]; fullBody: string | null; attachmentText: string | null;
  bodyPreview: string | null;
}) {
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

async function fetchSample(oppId: string) {
  const opp = await prisma.extractedOpportunity.findUnique({
    where: { id: oppId },
    include: { rawEmail: { include: { attachments: true } } },
  })
  if (!opp) throw new Error(`Opportunity ${oppId} not found`)
  const re = opp.rawEmail
  return {
    oppId,
    rawEmailId: re.id,
    subject: re.subject ?? '',
    senderName: re.senderName ?? null,
    senderEmail: re.senderEmail ?? null,
    bodyPreview: re.bodyPreview ?? null,
    fullBody: re.bodyContent ?? null,
    attachmentText: re.attachmentsText ?? null,
    attachmentNames: re.attachments.map(a => a.filename ?? '(unknown)'),
    storedCategory: opp.category,
    storedReason: opp.classificationReason,
    storedTitle: opp.extractedTitle,
    storedSummary: opp.extractedSummary,
    storedAddress: opp.address,
    storedPrice: opp.price,
    storedBeds: opp.beds,
    storedConfidence: opp.confidenceScore,
  }
}

type Kind = 'sale' | 'rental' | 'iso'

function pickKindFromCategory(cat: string): Kind {
  if (cat === 'BUYER_ISO') return 'iso'
  if (cat === 'RENTAL_LISTING' || cat === 'COMING_SOON_RENTAL') return 'rental'
  return 'sale'
}

async function runBaseline(kind: Kind, input: any) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const sys = kind === 'sale' ? SALE_SYSTEM : kind === 'rental' ? RENTAL_SYSTEM : ISO_SYSTEM
  const user = kind === 'iso' ? buildPromptISO(input) : buildPromptListing(input, kind)
  const t0 = Date.now()
  let raw = '{}'
  let err: string | null = null
  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: sys },
        { role: 'user',   content: user },
      ],
      temperature: 0,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
    })
    raw = res.choices[0].message.content ?? '{}'
  } catch (e) {
    err = (e as Error).message
  }
  const ms = Date.now() - t0
  let parsed: unknown = null
  let zod: any = null
  try { parsed = JSON.parse(raw) } catch (e) { zod = { ok: false, reason: 'JSON parse failed' } }
  if (parsed && !zod) {
    const schema = kind === 'sale' ? SaleResponse : kind === 'rental' ? RentalResponse : ISOResponse
    const r = schema.safeParse(parsed)
    zod = r.success
      ? { ok: true, data: r.data }
      : { ok: false, reason: `Zod: ${r.error.issues[0]?.message}`, issues: r.error.issues.slice(0,3) }
  }
  return { raw, parsed, zod, err, ms }
}

async function runSonnet(kind: Kind, input: any) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const sys = kind === 'sale' ? SALE_SYSTEM : kind === 'rental' ? RENTAL_SYSTEM : ISO_SYSTEM
  const user = kind === 'iso' ? buildPromptISO(input) : buildPromptListing(input, kind)
  const schemaJSON = kind === 'sale' ? SALE_TOOL_SCHEMA : kind === 'rental' ? RENTAL_TOOL_SCHEMA : ISO_TOOL_SCHEMA

  const desc = kind === 'sale'
    ? 'Extract one or more SALE listings (ACTIVE_SALE_LISTING/OFF_MARKET_SALE/BACK_ON_MARKET/PRICE_DROP/OPEN_HOUSE) from a NYC broker email.'
    : kind === 'rental'
    ? 'Extract one or more rental listings (RENTAL_LISTING/COMING_SOON_RENTAL) from a NYC broker email.'
    : 'Extract one or more buyer ISO (in-search-of) records from a NYC broker email.'

  const t0 = Date.now()
  let toolInput: any = null
  let err: string | null = null
  let raw: any = null
  try {
    const res = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: sys,
      messages: [{ role: 'user', content: user }],
      tools: [{
        name: 'extract_opportunity',
        description: desc,
        input_schema: schemaJSON as any,
      }],
      tool_choice: { type: 'tool', name: 'extract_opportunity' },
    })
    raw = res
    const tu = res.content.find(b => b.type === 'tool_use') as any
    toolInput = tu?.input ?? null
  } catch (e) {
    err = (e as Error).message
  }
  const ms = Date.now() - t0
  let zod: any = null
  if (toolInput) {
    const schema = kind === 'sale' ? SaleResponse : kind === 'rental' ? RentalResponse : ISOResponse
    const r = schema.safeParse(toolInput)
    zod = r.success
      ? { ok: true, data: r.data }
      : { ok: false, reason: `Zod: ${r.error.issues[0]?.message}`, issues: r.error.issues.slice(0,3) }
  }
  const usage = raw?.usage ?? null
  return { toolInput, zod, err, ms, usage }
}

function summarizeListings(zod: any, kind: Kind) {
  if (!zod?.ok) return '(zod failed)'
  if (kind === 'iso') {
    const isos = zod.data.isos as any[]
    return isos.map(i => `[ISO neighborhoods=${JSON.stringify(i.neighborhoods)} budget=${i.minPrice ?? '?'}-${i.maxPrice ?? '?'} beds=${i.beds ?? `${i.minBeds ?? '?'}-${i.maxBeds ?? '?'}`} type=${JSON.stringify(i.propertyTypes)}]`).join('\n  ')
  }
  const ls = zod.data.listings as any[]
  return ls.map(l => `[${l.category} addr=${l.address ?? 'null'} price=${l.price ?? 'null'} beds=${l.beds ?? 'null'} baths=${l.baths ?? 'null'} nbhd=${l.neighborhood ?? 'null'}]`).join('\n  ')
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════════')
  console.log('LIVE TEST — Claude Sonnet tool_use vs gpt-4o-mini json_object')
  console.log('═══════════════════════════════════════════════════════════════════\n')

  let totalSonnetIn = 0, totalSonnetOut = 0
  const sonnetInUsd = 3.0 / 1_000_000  // $3/M input
  const sonnetOutUsd = 15.0 / 1_000_000 // $15/M output

  for (const oppId of SAMPLE_OPP_IDS) {
    const s = await fetchSample(oppId)
    const kind = pickKindFromCategory(s.storedCategory)

    console.log(`\n┌─ SAMPLE: ${oppId}`)
    console.log(`│  Subject: ${s.subject.slice(0, 120)}`)
    console.log(`│  From:    ${s.senderName ?? '?'} <${s.senderEmail ?? '?'}>`)
    console.log(`│  Cat:     ${s.storedCategory}  | kind=${kind}`)
    console.log(`│  StoredReason: ${s.storedReason}`)
    console.log(`│  Body chars: full=${s.fullBody?.length ?? 0} preview=${s.bodyPreview?.length ?? 0} att=${s.attachmentText?.length ?? 0}`)
    console.log(`└──────────────────────────────────────────────────────────────────`)

    // BASELINE
    console.log(`\n  [BASELINE gpt-4o-mini json_object]`)
    const base = await runBaseline(kind, s)
    console.log(`    ms=${base.ms} err=${base.err ?? 'none'}`)
    console.log(`    Zod: ${base.zod?.ok ? 'PASS' : 'FAIL ' + base.zod?.reason}`)
    if (!base.zod?.ok) {
      console.log(`    Issues: ${JSON.stringify(base.zod?.issues ?? null, null, 2)}`)
      console.log(`    Raw (first 500): ${base.raw.slice(0, 500)}`)
    } else {
      console.log(`    Extracted: ${summarizeListings(base.zod, kind)}`)
    }

    // SONNET tool_use
    console.log(`\n  [SONNET claude-sonnet-4-6 tool_use forced]`)
    const son = await runSonnet(kind, s)
    console.log(`    ms=${son.ms} err=${son.err ?? 'none'} usage=in:${son.usage?.input_tokens ?? '?'} out:${son.usage?.output_tokens ?? '?'}`)
    if (son.usage) {
      totalSonnetIn += son.usage.input_tokens ?? 0
      totalSonnetOut += son.usage.output_tokens ?? 0
    }
    console.log(`    Zod: ${son.zod?.ok ? 'PASS' : 'FAIL ' + son.zod?.reason}`)
    if (!son.zod?.ok) {
      console.log(`    Issues: ${JSON.stringify(son.zod?.issues ?? null, null, 2)}`)
      console.log(`    ToolInput (first 800): ${JSON.stringify(son.toolInput).slice(0, 800)}`)
    } else {
      console.log(`    Extracted: ${summarizeListings(son.zod, kind)}`)
    }

    // Qualitative compare
    console.log(`\n  [QUALITATIVE]`)
    const baseN = base.zod?.ok ? (kind === 'iso' ? base.zod.data.isos.length : base.zod.data.listings.length) : 0
    const sonN  = son.zod?.ok  ? (kind === 'iso' ? son.zod.data.isos.length  : son.zod.data.listings.length)  : 0
    console.log(`    Records: baseline=${baseN}  sonnet=${sonN}`)
  }

  const cost = totalSonnetIn * sonnetInUsd + totalSonnetOut * sonnetOutUsd
  console.log(`\n═══════════════════════════════════════════════════════════════════`)
  console.log(`Sonnet total usage: in=${totalSonnetIn} out=${totalSonnetOut} → ~$${cost.toFixed(4)}`)
  console.log(`═══════════════════════════════════════════════════════════════════`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())

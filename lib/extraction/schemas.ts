// Phase 4.0 — Per-category extraction schemas for Sonnet tool_use.
//
// For each of the 11 V1 extractors we define, hand-translated from the inline
// Zod schema that actually runs in lib/ingestion/extractors/*:
//   1. a Zod response schema (post-call validation of Sonnet's tool_use.input)
//   2. a Claude JSON `input_schema` (forces the tool's argument shape)
//   3. the verbatim V1 system prompt (preserves tuned extraction behaviour)
//   4. a mapItem() that reproduces the extractor's item -> ExtractedOpportunity
//      field mapping, so V2 rows are shaped exactly like V1 rows.
//
// NOTE: the canonical schemas are the INLINE ones in each extractor file, not
// the (partially stale) shared ones in lib/ingestion/types.ts. We mirror the
// inline schemas here. Nothing in V1 is imported or modified.
//
// Scope note (Phase 4.0): BUYER_ISO / RENTER_INQUIRY items here populate the
// ExtractedOpportunity only. V1 additionally wrote a CriteriaProfile from a
// hidden `_criteriaProfile` blob; that is intentionally out of scope for 4.0
// and flagged for the planner.
import { z } from 'zod'
import type Anthropic from '@anthropic-ai/sdk'
import type { Category } from '@prisma/client'

// ── The row shape every mapItem produces (subset of ExtractedOpportunity that
//    an extractor sets; extractEmailV2 adds organizationId/rawEmailId/status). ─
export interface OppRowData {
  category:             string
  transactionType:      string
  propertyType:         string | null
  address:              string | null
  neighborhood:         string | null
  borough:              string | null
  city:                 string | null
  state:                string | null
  zip:                  string | null
  price:                number | null
  minPrice:             number | null
  maxPrice:             number | null
  beds:                 number | null
  baths:                number | null
  units:                number | null
  squareFeet:           number | null
  availabilityDate:     string | null
  sourceAgentName:      string | null
  sourceAgentEmail:     string | null
  sourceBrokerage:      string | null
  clientSide:           string | null
  status:               string | null
  extractedTitle:       string
  extractedSummary:     string
  classificationReason: string
  confidenceScore:      number
}

export interface MapCtx {
  subject:     string
  senderName:  string | null
  senderEmail: string | null
}

export interface ExtractionSpec {
  kind:            string
  toolName:        string
  toolDescription: string
  systemPrompt:    string
  /** Property name of the array inside the tool input (e.g. "listings"). */
  arrayKey:        string
  inputSchema:     Anthropic.Messages.Tool.InputSchema
  /** Zod schema for the full tool input (validates the array). */
  responseSchema:  z.ZodType
  /** Reproduces the V1 extractor's per-item field mapping. */
  mapItem:         (item: unknown, ctx: MapCtx) => OppRowData
}

// ── JSON-Schema field helpers ────────────────────────────────────────────────
const nstr = { type: ['string', 'null'] }
const nnum = { type: ['number', 'null'] }
const nint = { type: ['integer', 'null'] }
const rstr = { type: 'string' }
const conf = { type: 'number', minimum: 0, maximum: 1 }
const strArr = { type: 'array', items: { type: 'string' } }

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: 'object', properties, required }
}

function arrayInput(arrayKey: string, itemProps: Record<string, unknown>, itemRequired: string[]) {
  return {
    type: 'object',
    properties: {
      [arrayKey]: { type: 'array', items: objectSchema(itemProps, itemRequired) },
    },
    required: [arrayKey],
  } as Anthropic.Messages.Tool.InputSchema
}

// Common nullable text fields shared by listing-style extractors (Zod side).
const textTail = {
  extractedTitle:       z.string().nullish().transform(v => v ?? ''),
  extractedSummary:     z.string().nullish().transform(v => v ?? ''),
  classificationReason: z.string().nullish().transform(v => v ?? ''),
  confidenceScore:      z.number().min(0).max(1).nullish().transform(v => v ?? 0.7),
}
const textTailRequired = ['extractedTitle', 'extractedSummary', 'classificationReason', 'confidenceScore']
const textTailProps = { extractedTitle: rstr, extractedSummary: rstr, classificationReason: rstr, confidenceScore: conf }

// ─────────────────────────────────────────────────────────────────────────────
// 1. SALE  (ACTIVE_SALE_LISTING / OFF_MARKET_SALE / BACK_ON_MARKET / PRICE_DROP / OPEN_HOUSE)
// ─────────────────────────────────────────────────────────────────────────────
const SaleItem = z.object({
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
  ...textTail,
})
export const SaleResponse = z.object({ listings: z.array(SaleItem) })
type SaleT = z.infer<typeof SaleItem>

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

const SALE_ITEM_PROPS = {
  address: nstr, neighborhood: nstr, borough: nstr, city: nstr, state: nstr, zip: nstr,
  price: nnum, beds: nnum, baths: nnum, squareFeet: nnum, units: nnum,
  propertyType: nstr, availabilityDate: { ...nstr, description: 'ISO YYYY-MM-DD or null' }, status: nstr,
  category: { type: 'string', enum: ['ACTIVE_SALE_LISTING', 'OFF_MARKET_SALE', 'BACK_ON_MARKET', 'PRICE_DROP', 'OPEN_HOUSE'] },
  transactionType: { type: 'string', enum: ['SALE'] },
  sourceAgentName: nstr, sourceAgentEmail: nstr, sourceBrokerage: nstr, ...textTailProps,
}
const SALE_ITEM_REQUIRED = ['address', 'neighborhood', 'borough', 'city', 'state', 'zip', 'price', 'beds', 'baths', 'squareFeet', 'propertyType', 'availabilityDate', 'status', 'category', 'transactionType', 'sourceAgentName', 'sourceAgentEmail', 'sourceBrokerage', ...textTailRequired]

function mapSale(raw: unknown): OppRowData {
  const l = raw as SaleT
  return {
    category: l.category, transactionType: l.transactionType, propertyType: l.propertyType ?? null,
    address: l.address ?? null, neighborhood: l.neighborhood ?? null, borough: l.borough ?? null,
    city: l.city ?? null, state: l.state ?? null, zip: l.zip ?? null,
    price: l.price ?? null, minPrice: null, maxPrice: null,
    beds: l.beds ?? null, baths: l.baths ?? null, units: (l.units ?? null) as number | null,
    squareFeet: l.squareFeet ?? null, availabilityDate: l.availabilityDate ?? null,
    sourceAgentName: l.sourceAgentName ?? null, sourceAgentEmail: l.sourceAgentEmail ?? null,
    sourceBrokerage: l.sourceBrokerage ?? null, clientSide: null, status: l.status ?? null,
    extractedTitle: l.extractedTitle, extractedSummary: l.extractedSummary,
    classificationReason: l.classificationReason, confidenceScore: l.confidenceScore,
  }
}

const SALE_SPEC: ExtractionSpec = {
  kind: 'sale', toolName: 'extract_sale_listings',
  toolDescription: 'Extract one or more SALE-side listings (ACTIVE_SALE_LISTING / OFF_MARKET_SALE / BACK_ON_MARKET / PRICE_DROP / OPEN_HOUSE) from a NYC broker email.',
  systemPrompt: SALE_SYSTEM, arrayKey: 'listings',
  inputSchema: arrayInput('listings', SALE_ITEM_PROPS, SALE_ITEM_REQUIRED),
  responseSchema: SaleResponse, mapItem: mapSale,
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. RENTAL  (RENTAL_LISTING / COMING_SOON_RENTAL)
// ─────────────────────────────────────────────────────────────────────────────
const RentalItem = z.object({
  address:          z.string().nullable(),
  neighborhood:     z.string().nullable(),
  borough:          z.string().nullable(),
  city:             z.string().nullable(),
  state:            z.string().nullable(),
  zip:              z.string().nullable(),
  price:            z.number().nullable(),
  minPrice:         z.number().nullable(),
  maxPrice:         z.number().nullable(),
  beds:             z.number().nullable(),
  baths:            z.number().nullable(),
  squareFeet:       z.number().nullable(),
  units:            z.number().nullable().optional(),
  propertyType:     z.string().nullable(),
  availabilityDate: z.string().nullable(),
  status:           z.string().nullable(),
  category:         z.string(),
  transactionType:  z.string().nullish().transform(v => v ?? 'RENTAL'),
  sourceAgentName:  z.string().nullable(),
  sourceAgentEmail: z.string().nullable(),
  sourceBrokerage:  z.string().nullable(),
  ...textTail,
})
export const RentalResponse = z.object({ listings: z.array(RentalItem) })
type RentalT = z.infer<typeof RentalItem>

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

const RENTAL_ITEM_PROPS = {
  address: nstr, neighborhood: nstr, borough: nstr, city: nstr, state: nstr, zip: nstr,
  price: nnum, minPrice: nnum, maxPrice: nnum, beds: nnum, baths: nnum, squareFeet: nnum, units: nnum,
  propertyType: nstr, availabilityDate: { ...nstr, description: 'move-in date YYYY-MM-DD or null' }, status: nstr,
  category: { type: 'string', enum: ['RENTAL_LISTING', 'COMING_SOON_RENTAL'] },
  transactionType: { type: 'string', enum: ['RENTAL'] },
  sourceAgentName: nstr, sourceAgentEmail: nstr, sourceBrokerage: nstr, ...textTailProps,
}
const RENTAL_ITEM_REQUIRED = ['address', 'neighborhood', 'borough', 'city', 'state', 'zip', 'price', 'minPrice', 'maxPrice', 'beds', 'baths', 'squareFeet', 'propertyType', 'availabilityDate', 'status', 'category', 'transactionType', 'sourceAgentName', 'sourceAgentEmail', 'sourceBrokerage', ...textTailRequired]

function mapRental(raw: unknown): OppRowData {
  const l = raw as RentalT
  return {
    category: l.category, transactionType: l.transactionType, propertyType: l.propertyType ?? null,
    address: l.address ?? null, neighborhood: l.neighborhood ?? null, borough: l.borough ?? null,
    city: l.city ?? null, state: l.state ?? null, zip: l.zip ?? null,
    price: l.price ?? null, minPrice: l.minPrice ?? null, maxPrice: l.maxPrice ?? null,
    beds: l.beds ?? null, baths: l.baths ?? null, units: (l.units ?? null) as number | null,
    squareFeet: l.squareFeet ?? null, availabilityDate: l.availabilityDate ?? null,
    sourceAgentName: l.sourceAgentName ?? null, sourceAgentEmail: l.sourceAgentEmail ?? null,
    sourceBrokerage: l.sourceBrokerage ?? null, clientSide: null, status: l.status ?? null,
    extractedTitle: l.extractedTitle, extractedSummary: l.extractedSummary,
    classificationReason: l.classificationReason, confidenceScore: l.confidenceScore,
  }
}

const RENTAL_SPEC: ExtractionSpec = {
  kind: 'rental', toolName: 'extract_rental_listings',
  toolDescription: 'Extract one or more rental listings (RENTAL_LISTING / COMING_SOON_RENTAL) from a NYC broker email.',
  systemPrompt: RENTAL_SYSTEM, arrayKey: 'listings',
  inputSchema: arrayInput('listings', RENTAL_ITEM_PROPS, RENTAL_ITEM_REQUIRED),
  responseSchema: RentalResponse, mapItem: mapRental,
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. COMING SOON  (COMING_SOON_SALE / COMING_SOON_RENTAL)
// ─────────────────────────────────────────────────────────────────────────────
const ComingSoonItem = z.object({
  address:          z.string().nullable(),
  neighborhood:     z.string().nullable(),
  borough:          z.string().nullable(),
  city:             z.string().nullable(),
  state:            z.string().nullable(),
  zip:              z.string().nullable(),
  price:            z.number().nullable(),
  minPrice:         z.number().nullable(),
  maxPrice:         z.number().nullable(),
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
  ...textTail,
})
export const ComingSoonResponse = z.object({ listings: z.array(ComingSoonItem) })

const COMING_SOON_SYSTEM = `You are a NYC real estate extractor for pre-market listings. Extract structured data from "coming soon" emails about individual units not yet on market.

CATEGORIES:
- COMING_SOON_SALE — individual unit or property that will be listed for sale soon (not yet on MLS)
- COMING_SOON_RENTAL — individual unit that will be available for rent soon

DISTINGUISH FROM DEVELOPMENT_INVENTORY: Coming soon = single unit or small set of units at a specific address.
Development inventory = full building launch with multiple tier pricing ("1BR from $X, 2BR from $Y").

SUBJECT LINE IS KEY: Broker emails often put key details in the subject. Extract from subject first.

EXTRACTION RULES:
- Extract from subject line first, then body, then attachments
- address: specific unit address (e.g., "317 East 18th Street #4A"). Never null if stated in subject
- price: expected asking price as a number. For ranges, use minPrice/maxPrice
- availabilityDate: when the listing will go live or be available ("YYYY-MM-DD" or null)
- beds: number (0=studio). Never null if stated
- transactionType: "SALE" for COMING_SOON_SALE, "RENTAL" for COMING_SOON_RENTAL
- category: COMING_SOON_SALE or COMING_SOON_RENTAL
- confidenceScore: 0.9+ unambiguous, 0.7–0.9 probable

Return ONLY valid JSON: { "listings": [...] }`

const COMING_SOON_ITEM_PROPS = {
  address: nstr, neighborhood: nstr, borough: nstr, city: nstr, state: nstr, zip: nstr,
  price: nnum, minPrice: nnum, maxPrice: nnum, beds: nnum, baths: nnum, squareFeet: nnum, units: nnum,
  propertyType: nstr, availabilityDate: nstr, status: nstr,
  category: { type: 'string', enum: ['COMING_SOON_SALE', 'COMING_SOON_RENTAL'] },
  transactionType: { type: 'string', enum: ['SALE', 'RENTAL'] },
  sourceAgentName: nstr, sourceAgentEmail: nstr, sourceBrokerage: nstr, ...textTailProps,
}
const COMING_SOON_ITEM_REQUIRED = RENTAL_ITEM_REQUIRED

const COMING_SOON_SPEC: ExtractionSpec = {
  kind: 'comingSoon', toolName: 'extract_coming_soon_listings',
  toolDescription: 'Extract one or more pre-market "coming soon" listings (COMING_SOON_SALE / COMING_SOON_RENTAL) from a NYC broker email.',
  systemPrompt: COMING_SOON_SYSTEM, arrayKey: 'listings',
  inputSchema: arrayInput('listings', COMING_SOON_ITEM_PROPS, COMING_SOON_ITEM_REQUIRED),
  responseSchema: ComingSoonResponse, mapItem: mapRental, // identical item shape -> identical mapping
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. NEW DEVELOPMENT  (DEVELOPMENT_INVENTORY / COMING_SOON_DEVELOPMENT / SPONSOR_UNIT)
// ─────────────────────────────────────────────────────────────────────────────
const DevItem = z.object({
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
  ...textTail,
})
export const DevResponse = z.object({ listings: z.array(DevItem) })

const NEW_DEV_SYSTEM = `You are a NYC new development real estate extractor. Extract structured data from new development building announcements and sponsor unit emails.

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

const DEV_ITEM_PROPS = {
  address: nstr, neighborhood: nstr, borough: nstr, city: nstr, state: nstr, zip: nstr,
  beds: nnum, baths: nnum, squareFeet: nnum, units: nnum, price: nnum, minPrice: nnum, maxPrice: nnum,
  propertyType: nstr, availabilityDate: nstr, status: nstr,
  category: { type: 'string', enum: ['DEVELOPMENT_INVENTORY', 'COMING_SOON_DEVELOPMENT', 'SPONSOR_UNIT'] },
  transactionType: { type: 'string', enum: ['SALE'] },
  sourceAgentName: nstr, sourceAgentEmail: nstr, sourceBrokerage: nstr, ...textTailProps,
}
const DEV_ITEM_REQUIRED = ['address', 'neighborhood', 'borough', 'city', 'state', 'zip', 'beds', 'baths', 'squareFeet', 'price', 'minPrice', 'maxPrice', 'propertyType', 'availabilityDate', 'status', 'category', 'transactionType', 'sourceAgentName', 'sourceAgentEmail', 'sourceBrokerage', ...textTailRequired]

const NEW_DEV_SPEC: ExtractionSpec = {
  kind: 'newDev', toolName: 'extract_new_development',
  toolDescription: 'Extract new-development units (DEVELOPMENT_INVENTORY / COMING_SOON_DEVELOPMENT / SPONSOR_UNIT) from a NYC building-launch or sponsor-unit email.',
  systemPrompt: NEW_DEV_SYSTEM, arrayKey: 'listings',
  inputSchema: arrayInput('listings', DEV_ITEM_PROPS, DEV_ITEM_REQUIRED),
  responseSchema: DevResponse, mapItem: mapRental, // same field set -> same mapping
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. BUYER ISO
// ─────────────────────────────────────────────────────────────────────────────
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
export const ISOResponse = z.object({ isos: z.array(ISOItem) })
type ISOT = z.infer<typeof ISOItem>

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

const ISO_ITEM_PROPS = {
  neighborhoods: strArr, borough: nstr, minPrice: nnum, maxPrice: nnum, minBeds: nint, maxBeds: nint, beds: nnum,
  propertyTypes: strArr, mustHaves: nstr, dealbreakers: nstr, timeline: nstr,
  sourceAgentName: nstr, sourceAgentEmail: nstr, sourceBrokerage: nstr, clientSide: nstr,
  extractedTitle: rstr, extractedSummary: rstr, classificationReason: rstr, confidenceScore: conf,
}
const ISO_ITEM_REQUIRED = ['neighborhoods', 'borough', 'minPrice', 'maxPrice', 'minBeds', 'maxBeds', 'beds', 'propertyTypes', 'mustHaves', 'dealbreakers', 'timeline', 'sourceAgentName', 'sourceAgentEmail', 'sourceBrokerage', 'clientSide', ...textTailRequired]

function mapISO(raw: unknown): OppRowData {
  const iso = raw as ISOT
  const primaryNeighborhood = iso.neighborhoods[0] ?? null
  const price = iso.minPrice && iso.maxPrice
    ? Math.round((iso.minPrice + iso.maxPrice) / 2)
    : iso.maxPrice ?? iso.minPrice ?? null
  const beds = iso.beds ?? (
    iso.minBeds != null && iso.maxBeds != null
      ? (iso.minBeds + iso.maxBeds) / 2
      : iso.maxBeds ?? iso.minBeds ?? null
  )
  const summary = [
    iso.neighborhoods.length > 0 ? iso.neighborhoods.join(' / ') : null,
    iso.minPrice && iso.maxPrice ? `$${(iso.minPrice / 1e6).toFixed(1)}M–$${(iso.maxPrice / 1e6).toFixed(1)}M` : null,
    beds ? `${beds}BR` : null,
    iso.propertyTypes.length > 0 ? iso.propertyTypes.join('/') : null,
    iso.mustHaves ? `Needs: ${iso.mustHaves}` : null,
  ].filter(Boolean).join(' · ')
  return {
    category: 'BUYER_ISO', transactionType: 'BUYER_NEED', propertyType: iso.propertyTypes[0] ?? null,
    address: null, neighborhood: primaryNeighborhood, borough: iso.borough ?? null,
    city: 'New York', state: 'NY', zip: null,
    price, minPrice: iso.minPrice ?? null, maxPrice: iso.maxPrice ?? null,
    beds, baths: null, units: null, squareFeet: null, availabilityDate: iso.timeline ?? null,
    sourceAgentName: iso.sourceAgentName ?? null, sourceAgentEmail: iso.sourceAgentEmail ?? null,
    sourceBrokerage: iso.sourceBrokerage ?? null, clientSide: 'buyer', status: null,
    extractedTitle: iso.extractedTitle, extractedSummary: summary || iso.extractedSummary,
    classificationReason: iso.classificationReason, confidenceScore: iso.confidenceScore,
  }
}

const ISO_SPEC: ExtractionSpec = {
  kind: 'buyerISO', toolName: 'extract_buyer_iso',
  toolDescription: 'Extract one or more buyer ISO (in-search-of) search-criteria records from a NYC broker broadcast email.',
  systemPrompt: ISO_SYSTEM, arrayKey: 'isos',
  inputSchema: arrayInput('isos', ISO_ITEM_PROPS, ISO_ITEM_REQUIRED),
  responseSchema: ISOResponse, mapItem: mapISO,
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. RENTER INQUIRY
// ─────────────────────────────────────────────────────────────────────────────
const RenterItem = z.object({
  neighborhoods:    z.array(z.string()).default([]),
  borough:          z.string().nullable(),
  maxPrice:         z.number().nullable(),
  minPrice:         z.number().nullable(),
  minBeds:          z.number().int().nullable(),
  maxBeds:          z.number().int().nullable(),
  beds:             z.number().nullable(),
  moveInDate:       z.string().nullable(),
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
export const RenterResponse = z.object({ renters: z.array(RenterItem) })
type RenterT = z.infer<typeof RenterItem>

const RENTER_SYSTEM = `You are a NYC real estate renter inquiry extractor. Extract structured renter search criteria from agent broadcast emails.

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

const RENTER_ITEM_PROPS = {
  neighborhoods: strArr, borough: nstr, maxPrice: nnum, minPrice: nnum, minBeds: nint, maxBeds: nint, beds: nnum,
  moveInDate: nstr, propertyTypes: strArr, mustHaves: nstr, dealbreakers: nstr,
  sourceAgentName: nstr, sourceAgentEmail: nstr, sourceBrokerage: nstr,
  extractedTitle: rstr, extractedSummary: rstr, classificationReason: rstr, confidenceScore: conf,
}
const RENTER_ITEM_REQUIRED = ['neighborhoods', 'borough', 'maxPrice', 'minPrice', 'minBeds', 'maxBeds', 'beds', 'moveInDate', 'propertyTypes', 'mustHaves', 'dealbreakers', 'sourceAgentName', 'sourceAgentEmail', 'sourceBrokerage', ...textTailRequired]

function mapRenter(raw: unknown): OppRowData {
  const r = raw as RenterT
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
    category: 'RENTER_INQUIRY', transactionType: 'RENTER_NEED', propertyType: r.propertyTypes[0] ?? null,
    address: null, neighborhood: primaryNeighborhood, borough: r.borough ?? null,
    city: 'New York', state: 'NY', zip: null,
    price: r.maxPrice ?? null, minPrice: r.minPrice ?? null, maxPrice: r.maxPrice ?? null,
    beds, baths: null, units: null, squareFeet: null, availabilityDate: r.moveInDate ?? null,
    sourceAgentName: r.sourceAgentName ?? null, sourceAgentEmail: r.sourceAgentEmail ?? null,
    sourceBrokerage: r.sourceBrokerage ?? null, clientSide: 'renter', status: null,
    extractedTitle: r.extractedTitle, extractedSummary: summary || r.extractedSummary,
    classificationReason: r.classificationReason, confidenceScore: r.confidenceScore,
  }
}

const RENTER_SPEC: ExtractionSpec = {
  kind: 'renterInquiry', toolName: 'extract_renter_inquiry',
  toolDescription: 'Extract one or more renter inquiry (search-criteria) records from a NYC broker broadcast email.',
  systemPrompt: RENTER_SYSTEM, arrayKey: 'renters',
  inputSchema: arrayInput('renters', RENTER_ITEM_PROPS, RENTER_ITEM_REQUIRED),
  responseSchema: RenterResponse, mapItem: mapRenter,
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. SELLER LEAD
// ─────────────────────────────────────────────────────────────────────────────
const SellerItem = z.object({
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
  sourceAgentName:  z.string().nullable(),
  sourceAgentEmail: z.string().nullable(),
  sourceBrokerage:  z.string().nullable(),
  motivation:       z.string().nullable(),
  ...textTail,
})
export const SellerResponse = z.object({ leads: z.array(SellerItem) })
type SellerT = z.infer<typeof SellerItem>

const SELLER_SYSTEM = `You are a NYC real estate seller lead extractor. Extract structured data from emails where a homeowner or agent signals interest in listing a property for sale.

SELLER LEAD signals:
- Owner reaching out asking about listing their property
- Referral from another agent ("I have a potential seller at 123 Main St")
- Homeowner inquiry about market value or selling timeline
- An agent's client who owns a property and is considering listing

EXTRACTION RULES:
- address: the property address they want to list, if stated
- price: their asking price or estimated value if mentioned
- beds/baths/squareFeet: the property's details if stated
- motivation: brief note on why they're selling if mentioned (estate, divorce, relocation, downsizing, etc.)
- availabilityDate: when they're thinking of listing ("YYYY-MM-DD" or null)
- sourceAgentName/Email: the person who sent the email (seller or referring agent)
- propertyType: condo, co-op, townhouse, multi-family, etc.
- transactionType: always "SALE"
- Never invent address, price, or motivation. Use null if not stated
- confidenceScore: 0.9+ unambiguous, 0.7–0.9 probable

Return ONLY valid JSON: { "leads": [...] }`

const SELLER_ITEM_PROPS = {
  address: nstr, neighborhood: nstr, borough: nstr, city: nstr, state: nstr, zip: nstr,
  price: nnum, beds: nnum, baths: nnum, squareFeet: nnum, units: nnum,
  propertyType: nstr, availabilityDate: nstr, status: nstr,
  sourceAgentName: nstr, sourceAgentEmail: nstr, sourceBrokerage: nstr, motivation: nstr, ...textTailProps,
}
const SELLER_ITEM_REQUIRED = ['address', 'neighborhood', 'borough', 'city', 'state', 'zip', 'price', 'beds', 'baths', 'squareFeet', 'propertyType', 'availabilityDate', 'status', 'sourceAgentName', 'sourceAgentEmail', 'sourceBrokerage', 'motivation', ...textTailRequired]

function mapSeller(raw: unknown): OppRowData {
  const l = raw as SellerT
  return {
    category: 'SELLER_LEAD', transactionType: 'SALE', propertyType: l.propertyType ?? null,
    address: l.address ?? null, neighborhood: l.neighborhood ?? null, borough: l.borough ?? null,
    city: l.city ?? null, state: l.state ?? null, zip: l.zip ?? null,
    price: l.price ?? null, minPrice: null, maxPrice: null,
    beds: l.beds ?? null, baths: l.baths ?? null, units: (l.units ?? null) as number | null,
    squareFeet: l.squareFeet ?? null, availabilityDate: l.availabilityDate ?? null,
    sourceAgentName: l.sourceAgentName ?? null, sourceAgentEmail: l.sourceAgentEmail ?? null,
    sourceBrokerage: l.sourceBrokerage ?? null, clientSide: 'seller', status: l.status ?? null,
    extractedTitle: l.extractedTitle,
    extractedSummary: l.motivation ? `${l.extractedSummary} Motivation: ${l.motivation}` : l.extractedSummary,
    classificationReason: l.classificationReason, confidenceScore: l.confidenceScore,
  }
}

const SELLER_SPEC: ExtractionSpec = {
  kind: 'sellerLead', toolName: 'extract_seller_lead',
  toolDescription: 'Extract one or more seller-lead records (a homeowner/agent signalling interest in listing a property for sale) from an email.',
  systemPrompt: SELLER_SYSTEM, arrayKey: 'leads',
  inputSchema: arrayInput('leads', SELLER_ITEM_PROPS, SELLER_ITEM_REQUIRED),
  responseSchema: SellerResponse, mapItem: mapSeller,
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. LANDLORD LEAD
// ─────────────────────────────────────────────────────────────────────────────
const LandlordItem = z.object({
  address:          z.string().nullable(),
  neighborhood:     z.string().nullable(),
  borough:          z.string().nullable(),
  city:             z.string().nullable(),
  state:            z.string().nullable(),
  zip:              z.string().nullable(),
  price:            z.number().nullable(),
  minPrice:         z.number().nullable(),
  maxPrice:         z.number().nullable(),
  beds:             z.number().nullable(),
  baths:            z.number().nullable(),
  squareFeet:       z.number().nullable(),
  units:            z.number().nullable().optional(),
  propertyType:     z.string().nullable(),
  availabilityDate: z.string().nullable(),
  status:           z.string().nullable(),
  sourceAgentName:  z.string().nullable(),
  sourceAgentEmail: z.string().nullable(),
  sourceBrokerage:  z.string().nullable(),
  leaseType:        z.string().nullable(),
  ...textTail,
})
export const LandlordResponse = z.object({ leads: z.array(LandlordItem) })
type LandlordT = z.infer<typeof LandlordItem>

const LANDLORD_SYSTEM = `You are a NYC real estate landlord lead extractor. Extract structured data from emails where a landlord is looking to rent a unit and wants agent representation.

LANDLORD LEAD signals:
- Landlord reaching out about listing a rental unit
- Referral from another agent ("I have a landlord with a 2BR in the West Village")
- Building owner looking for a tenant
- Property manager seeking to fill a vacancy

EXTRACTION RULES:
- address: the rental property address, if stated
- price: the asking monthly rent as a number (e.g. 4500, not "$4,500/mo")
- beds/baths/squareFeet: the unit's details if stated
- leaseType: "12-month", "month-to-month", "flexible", or null
- availabilityDate: when the unit is available ("YYYY-MM-DD" or null)
- sourceAgentName/Email: the person who sent the email
- propertyType: apartment, condo, co-op, townhouse, multi-family, etc.
- transactionType: always "RENTAL"
- Never invent address, rent, or details. Use null if not stated
- confidenceScore: 0.9+ unambiguous, 0.7–0.9 probable

Return ONLY valid JSON: { "leads": [...] }`

const LANDLORD_ITEM_PROPS = {
  address: nstr, neighborhood: nstr, borough: nstr, city: nstr, state: nstr, zip: nstr,
  price: nnum, minPrice: nnum, maxPrice: nnum, beds: nnum, baths: nnum, squareFeet: nnum, units: nnum,
  propertyType: nstr, availabilityDate: nstr, status: nstr,
  sourceAgentName: nstr, sourceAgentEmail: nstr, sourceBrokerage: nstr, leaseType: nstr, ...textTailProps,
}
const LANDLORD_ITEM_REQUIRED = ['address', 'neighborhood', 'borough', 'city', 'state', 'zip', 'price', 'minPrice', 'maxPrice', 'beds', 'baths', 'squareFeet', 'propertyType', 'availabilityDate', 'status', 'sourceAgentName', 'sourceAgentEmail', 'sourceBrokerage', 'leaseType', ...textTailRequired]

function mapLandlord(raw: unknown): OppRowData {
  const l = raw as LandlordT
  return {
    category: 'LANDLORD_LEAD', transactionType: 'RENTAL', propertyType: l.propertyType ?? null,
    address: l.address ?? null, neighborhood: l.neighborhood ?? null, borough: l.borough ?? null,
    city: l.city ?? null, state: l.state ?? null, zip: l.zip ?? null,
    price: l.price ?? null, minPrice: l.minPrice ?? null, maxPrice: l.maxPrice ?? null,
    beds: l.beds ?? null, baths: l.baths ?? null, units: (l.units ?? null) as number | null,
    squareFeet: l.squareFeet ?? null, availabilityDate: l.availabilityDate ?? null,
    sourceAgentName: l.sourceAgentName ?? null, sourceAgentEmail: l.sourceAgentEmail ?? null,
    sourceBrokerage: l.sourceBrokerage ?? null, clientSide: 'landlord', status: l.status ?? null,
    extractedTitle: l.extractedTitle,
    extractedSummary: l.leaseType ? `${l.extractedSummary} Lease: ${l.leaseType}` : l.extractedSummary,
    classificationReason: l.classificationReason, confidenceScore: l.confidenceScore,
  }
}

const LANDLORD_SPEC: ExtractionSpec = {
  kind: 'landlordLead', toolName: 'extract_landlord_lead',
  toolDescription: 'Extract one or more landlord-lead records (a landlord/agent looking to rent out a unit and seeking representation) from an email.',
  systemPrompt: LANDLORD_SYSTEM, arrayKey: 'leads',
  inputSchema: arrayInput('leads', LANDLORD_ITEM_PROPS, LANDLORD_ITEM_REQUIRED),
  responseSchema: LandlordResponse, mapItem: mapLandlord,
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. MARKET REPORT / REAL ESTATE EVENT
// ─────────────────────────────────────────────────────────────────────────────
const ReportItem = z.object({
  category:         z.string(),
  neighborhood:     z.string().nullable(),
  borough:          z.string().nullable(),
  eventDate:        z.string().nullable(),
  eventLocation:    z.string().nullable(),
  publisher:        z.string().nullable(),
  periodCovered:    z.string().nullable(),
  keyTakeaway:      z.string().nullable(),
  sourceAgentName:  z.string().nullable(),
  sourceAgentEmail: z.string().nullable(),
  sourceBrokerage:  z.string().nullable(),
  ...textTail,
})
export const ReportResponse = z.object({ items: z.array(ReportItem) })
type ReportT = z.infer<typeof ReportItem>

const REPORT_SYSTEM = `You are a NYC real estate informational email extractor. Extract structured data from market reports and real estate event announcements.

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

const REPORT_ITEM_PROPS = {
  category: { type: 'string', enum: ['MARKET_REPORT', 'REAL_ESTATE_EVENT'] },
  neighborhood: nstr, borough: nstr, eventDate: nstr, eventLocation: nstr,
  publisher: nstr, periodCovered: nstr, keyTakeaway: nstr,
  sourceAgentName: nstr, sourceAgentEmail: nstr, sourceBrokerage: nstr, ...textTailProps,
}
const REPORT_ITEM_REQUIRED = ['category', 'neighborhood', 'borough', 'eventDate', 'eventLocation', 'publisher', 'periodCovered', 'keyTakeaway', 'sourceAgentName', 'sourceAgentEmail', 'sourceBrokerage', ...textTailRequired]

function mapReport(raw: unknown): OppRowData {
  const item = raw as ReportT
  return {
    category: item.category, transactionType: 'INFORMATIONAL', propertyType: null,
    address: item.eventLocation ?? null, neighborhood: item.neighborhood ?? null, borough: item.borough ?? null,
    city: 'New York', state: 'NY', zip: null,
    price: null, minPrice: null, maxPrice: null,
    beds: null, baths: null, units: null, squareFeet: null, availabilityDate: item.eventDate ?? null,
    sourceAgentName: item.sourceAgentName ?? null, sourceAgentEmail: item.sourceAgentEmail ?? null,
    sourceBrokerage: item.sourceBrokerage ?? item.publisher ?? null, clientSide: null, status: null,
    extractedTitle: item.extractedTitle,
    extractedSummary: item.keyTakeaway ? `${item.extractedSummary} Key finding: ${item.keyTakeaway}` : item.extractedSummary,
    classificationReason: item.classificationReason, confidenceScore: item.confidenceScore,
  }
}

const REPORT_SPEC: ExtractionSpec = {
  kind: 'marketReport', toolName: 'extract_market_report',
  toolDescription: 'Extract market-report or real-estate-event records (MARKET_REPORT / REAL_ESTATE_EVENT) from an informational email.',
  systemPrompt: REPORT_SYSTEM, arrayKey: 'items',
  inputSchema: arrayInput('items', REPORT_ITEM_PROPS, REPORT_ITEM_REQUIRED),
  responseSchema: ReportResponse, mapItem: mapReport,
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. CLIENT CONVERSATION
// ─────────────────────────────────────────────────────────────────────────────
const ConversationItem = z.object({
  clientName:       z.string().nullable(),
  clientEmail:      z.string().nullable(),
  agentName:        z.string().nullable(),
  agentEmail:       z.string().nullable(),
  brokerage:        z.string().nullable(),
  clientSide:       z.string().nullable(),
  neighborhood:     z.string().nullable(),
  borough:          z.string().nullable(),
  price:            z.number().nullable(),
  beds:             z.number().nullable(),
  propertyType:     z.string().nullable(),
  address:          z.string().nullable(),
  keyTopics:        z.string().nullable(),
  nextStep:         z.string().nullable(),
  ...textTail,
})
export const ConversationResponse = z.object({ conversations: z.array(ConversationItem) })
type ConversationT = z.infer<typeof ConversationItem>

const CONVERSATION_SYSTEM = `You are a NYC real estate conversation extractor. Extract structured data from direct client or agent conversations — NOT broadcast listing emails.

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
- confidenceScore: 0.9+ clear, 0.7–0.9 probable

Return ONLY valid JSON: { "conversations": [...] }`

const CONVERSATION_ITEM_PROPS = {
  clientName: nstr, clientEmail: nstr, agentName: nstr, agentEmail: nstr, brokerage: nstr, clientSide: nstr,
  neighborhood: nstr, borough: nstr, price: nnum, beds: nnum, propertyType: nstr, address: nstr,
  keyTopics: nstr, nextStep: nstr, ...textTailProps,
}
const CONVERSATION_ITEM_REQUIRED = ['clientName', 'clientEmail', 'agentName', 'agentEmail', 'brokerage', 'clientSide', 'neighborhood', 'borough', 'price', 'beds', 'propertyType', 'address', 'keyTopics', 'nextStep', ...textTailRequired]

function mapConversation(raw: unknown, ctx: MapCtx): OppRowData {
  const c = raw as ConversationT
  return {
    category: 'CLIENT_CONVERSATION', transactionType: 'UNKNOWN', propertyType: c.propertyType ?? null,
    address: c.address ?? null, neighborhood: c.neighborhood ?? null, borough: c.borough ?? null,
    city: 'New York', state: 'NY', zip: null,
    price: c.price ?? null, minPrice: null, maxPrice: null,
    beds: c.beds ?? null, baths: null, units: null, squareFeet: null, availabilityDate: null,
    sourceAgentName: c.agentName ?? ctx.senderName ?? null,
    sourceAgentEmail: c.agentEmail ?? ctx.senderEmail ?? null,
    sourceBrokerage: c.brokerage ?? null, clientSide: c.clientSide ?? null, status: null,
    extractedTitle: c.extractedTitle,
    extractedSummary: [c.extractedSummary, c.nextStep ? `Next: ${c.nextStep}` : null].filter(Boolean).join(' '),
    classificationReason: c.classificationReason, confidenceScore: c.confidenceScore,
  }
}

const CONVERSATION_SPEC: ExtractionSpec = {
  kind: 'clientConversation', toolName: 'extract_client_conversation',
  toolDescription: 'Extract client-conversation context (a direct client/agent email, not a broadcast listing) into one or more records.',
  systemPrompt: CONVERSATION_SYSTEM, arrayKey: 'conversations',
  inputSchema: arrayInput('conversations', CONVERSATION_ITEM_PROPS, CONVERSATION_ITEM_REQUIRED),
  responseSchema: ConversationResponse, mapItem: mapConversation,
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. SHOWING CONFIRMATION
// ─────────────────────────────────────────────────────────────────────────────
const ShowingItem = z.object({
  address:          z.string().nullable(),
  neighborhood:     z.string().nullable(),
  borough:          z.string().nullable(),
  confirmedDate:    z.string().nullable(),
  confirmedTime:    z.string().nullable(),
  confirmingAgent:  z.string().nullable(),
  confirmingEmail:  z.string().nullable(),
  brokerage:        z.string().nullable(),
  attendees:        z.string().nullable(),
  propertyType:     z.string().nullable(),
  beds:             z.number().nullable(),
  price:            z.number().nullable(),
  ...textTail,
})
export const ShowingResponse = z.object({ showings: z.array(ShowingItem) })
type ShowingT = z.infer<typeof ShowingItem>

const SHOWING_SYSTEM = `You are a NYC real estate showing confirmation extractor. Extract structured data from emails confirming a property showing appointment.

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

const SHOWING_ITEM_PROPS = {
  address: nstr, neighborhood: nstr, borough: nstr, confirmedDate: nstr, confirmedTime: nstr,
  confirmingAgent: nstr, confirmingEmail: nstr, brokerage: nstr, attendees: nstr,
  propertyType: nstr, beds: nnum, price: nnum, ...textTailProps,
}
const SHOWING_ITEM_REQUIRED = ['address', 'neighborhood', 'borough', 'confirmedDate', 'confirmedTime', 'confirmingAgent', 'confirmingEmail', 'brokerage', 'attendees', 'propertyType', 'beds', 'price', ...textTailRequired]

function mapShowing(raw: unknown, ctx: MapCtx): OppRowData {
  const s = raw as ShowingT
  const availabilityDate = s.confirmedDate
    ? (s.confirmedTime ? `${s.confirmedDate}T${s.confirmedTime}` : s.confirmedDate)
    : null
  return {
    category: 'SHOWING_CONFIRMATION', transactionType: 'UNKNOWN', propertyType: s.propertyType ?? null,
    address: s.address ?? null, neighborhood: s.neighborhood ?? null, borough: s.borough ?? null,
    city: 'New York', state: 'NY', zip: null,
    price: s.price ?? null, minPrice: null, maxPrice: null,
    beds: s.beds ?? null, baths: null, units: null, squareFeet: null, availabilityDate,
    sourceAgentName: s.confirmingAgent ?? ctx.senderName ?? null,
    sourceAgentEmail: s.confirmingEmail ?? ctx.senderEmail ?? null,
    sourceBrokerage: s.brokerage ?? null, clientSide: null, status: 'confirmed',
    extractedTitle: s.extractedTitle, extractedSummary: s.extractedSummary,
    classificationReason: s.classificationReason, confidenceScore: s.confidenceScore,
  }
}

const SHOWING_SPEC: ExtractionSpec = {
  kind: 'showingConfirmation', toolName: 'extract_showing_confirmation',
  toolDescription: 'Extract confirmed-showing-appointment details (SHOWING_CONFIRMATION) from a confirmation email.',
  systemPrompt: SHOWING_SYSTEM, arrayKey: 'showings',
  inputSchema: arrayInput('showings', SHOWING_ITEM_PROPS, SHOWING_ITEM_REQUIRED),
  responseSchema: ShowingResponse, mapItem: mapShowing,
}

// ── Category -> spec map (mirrors lib/ingestion/extractionRouter EXTRACTOR_MAP) ─
// NOISE has no extraction spec (extractEmailV2 returns []).
export const EXTRACTION_SPEC_BY_CATEGORY: Record<Category, ExtractionSpec | null> = {
  ACTIVE_SALE_LISTING:     SALE_SPEC,
  OFF_MARKET_SALE:         SALE_SPEC,
  BACK_ON_MARKET:          SALE_SPEC,
  PRICE_DROP:              SALE_SPEC,
  OPEN_HOUSE:              SALE_SPEC,
  RENTAL_LISTING:          RENTAL_SPEC,
  COMING_SOON_SALE:        COMING_SOON_SPEC,
  COMING_SOON_RENTAL:      COMING_SOON_SPEC,
  DEVELOPMENT_INVENTORY:   NEW_DEV_SPEC,
  COMING_SOON_DEVELOPMENT: NEW_DEV_SPEC,
  SPONSOR_UNIT:            NEW_DEV_SPEC,
  BUYER_ISO:               ISO_SPEC,
  RENTER_INQUIRY:          RENTER_SPEC,
  SELLER_LEAD:             SELLER_SPEC,
  LANDLORD_LEAD:           LANDLORD_SPEC,
  MARKET_REPORT:           REPORT_SPEC,
  REAL_ESTATE_EVENT:       REPORT_SPEC,
  CLIENT_CONVERSATION:     CONVERSATION_SPEC,
  SHOWING_CONFIRMATION:    SHOWING_SPEC,
  NOISE:                   null,
}

// Convenience map the Phase 4.0 brief names explicitly: just the input_schema.
export const INPUT_SCHEMA_BY_CATEGORY: Record<Category, Anthropic.Messages.Tool.InputSchema | null> =
  Object.fromEntries(
    (Object.entries(EXTRACTION_SPEC_BY_CATEGORY) as [Category, ExtractionSpec | null][])
      .map(([cat, spec]) => [cat, spec ? spec.inputSchema : null]),
  ) as Record<Category, Anthropic.Messages.Tool.InputSchema | null>

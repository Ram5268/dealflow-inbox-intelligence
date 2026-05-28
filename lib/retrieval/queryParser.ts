import OpenAI from 'openai'
import { classifyIntent } from './intentClassifier'
import type { ParsedQuery, IntentBucket } from './types'
import { NEIGHBORHOODS, BOROUGHS } from '../domain/Neighborhood'

// Pre-built variant→canonical index used by extractNeighborhoods. Built once
// at module load. Each variant is lowercased and stored with its canonical;
// substring containment scan returns the canonicals that appear in input.
// Replaces the old hand-maintained NYC_NEIGHBORHOODS array — every spelling
// in lib/domain/Neighborhood.ts variants is now recognized, including
// shorthand like "bedstuy", "fidi", "ues", "uws", "lic".
const VARIANT_INDEX: Array<{ lower: string; canonical: string }> = (() => {
  const seen = new Set<string>()
  const out: Array<{ lower: string; canonical: string }> = []
  for (const [canonical, meta] of Object.entries(NEIGHBORHOODS)) {
    for (const v of meta.variants) {
      const key = v.toLowerCase()
      if (key.length < 3) continue            // guard against pathological short variants
      if (seen.has(key + '||' + canonical)) continue
      seen.add(key + '||' + canonical)
      out.push({ lower: key, canonical })
    }
  }
  // Longest first so "stuyvesant heights" matches before "stuy", "long island city" before "lic", etc.
  out.sort((a, b) => b.lower.length - a.lower.length)
  return out
})()

// Price words → multiplier
const PRICE_MULTIPLIERS: Record<string, number> = {
  'k': 1_000, 'K': 1_000,
  'm': 1_000_000, 'M': 1_000_000,
}

// Bed aliases → number
const BED_WORDS: Record<string, number> = {
  'studio': 0, 'studios': 0,
  'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
}

// Mirror inline route's MY_BUYER_PATTERN + INTENT_PROMPT seller-lead / email-campaign cues
const MY_BUYER_PATTERN       = /\bmy\s+buyer\b|\bi\s+have\s+a\s+buyer\b|\bfor\s+my\s+(buyer|client)\b|\bmy\s+client\b/i
const SELLER_LEAD_PATTERN    = /\bseller\s+leads?\b|\bcold\s+call\b|\bwho\s+can\s+i\s+call\b|\bpotential\s+sellers?\b|\bseller\s+prospects?\b/i
const EMAIL_CAMPAIGN_PATTERN = /\bemail\s+(repl(?:ies|y)|open|campaign)\b|\binstantly\b|\bcampaign\s+(performance|stats?|results?)\b/i

// Phrases that signal the user explicitly wants adjacent/nearby/similar
// results — broaden mode. When this matches, queryPlanner expands neighborhood
// adjacency. When it doesn't, results are strict (only the named neighborhood
// + its variant spellings). See lib/retrieval/queryPlanner.ts.
const BROADEN_PATTERNS = /\b(near|around|close to|nearby|by\s+\w+|or\s+(similar|adjacent|surrounding|nearby)|in or (around|near)|and\s+(similar|nearby))\b/i

function parsePrice(raw: string): number | null {
  const m = raw.replace(/,/g, '').match(/\$?([\d.]+)\s*([kKmM]?)/)
  if (!m) return null
  const base = parseFloat(m[1])
  const mult = PRICE_MULTIPLIERS[m[2]] ?? 1
  return Math.round(base * mult)
}

function extractBeds(text: string): { beds: number | null; minBeds: number | null; maxBeds: number | null } {
  const lower = text.toLowerCase()

  // "2-3BR", "2 to 3 bed"
  const rangeMatch = lower.match(/(\d+)\s*(?:to|-)\s*(\d+)\s*(?:br|bed|bedroom)/)
  if (rangeMatch) return { beds: null, minBeds: parseInt(rangeMatch[1]), maxBeds: parseInt(rangeMatch[2]) }

  // "2BR", "2 bed", "2 bedroom"
  const exactNum = lower.match(/(\d+)\s*(?:br|bed|bedroom)/)
  if (exactNum) return { beds: parseInt(exactNum[1]), minBeds: null, maxBeds: null }

  // "studio", "one bedroom", etc.
  for (const [word, num] of Object.entries(BED_WORDS)) {
    if (lower.includes(word)) return { beds: num, minBeds: null, maxBeds: null }
  }

  return { beds: null, minBeds: null, maxBeds: null }
}

// "N-family" / "multi-family" / "N-unit" → building residential-unit count.
// NYC parlance: a "3 family" is a building with 3 units, NOT a 3BR apartment.
// Returns minUnits/maxUnits filters that downstream SQL applies against the
// `units` field on ExtractedOpportunity.
function extractUnits(text: string): { minUnits: number | null; maxUnits: number | null } {
  const lower = text.toLowerCase()

  // "single family" / "single-family" → exactly 1 unit
  if (/\bsingle[\s-]family\b/.test(lower)) return { minUnits: 1, maxUnits: 1 }

  // "multi-family" / "multi family" → ≥ 2 units (no upper bound)
  if (/\bmulti[\s-]family\b/.test(lower)) return { minUnits: 2, maxUnits: null }

  // "N to M family" / "N-M family" / "N-M unit" → range
  const rangeMatch = lower.match(/(\d+)\s*(?:to|-)\s*(\d+)\s*(?:family|unit|units)\b/)
  if (rangeMatch) return {
    minUnits: parseInt(rangeMatch[1]),
    maxUnits: parseInt(rangeMatch[2]),
  }

  // "N-family" / "N family" / "N-unit" / "N unit" / "N units" → exact N
  const exactMatch = lower.match(/(\d+)[\s-](?:family|unit|units)\b/)
  if (exactMatch) {
    const n = parseInt(exactMatch[1])
    return { minUnits: n, maxUnits: n }
  }

  return { minUnits: null, maxUnits: null }
}

function extractPrices(text: string): { minPrice: number | null; maxPrice: number | null } {
  const lower = text.toLowerCase()

  // "$1.5M-$2M" or "$1.5M to $2M"
  const rangeMatch = text.match(/\$[\d.,]+[kKmM]?\s*(?:to|-)\s*\$[\d.,]+[kKmM]?/i)
  if (rangeMatch) {
    const parts = rangeMatch[0].split(/to|-/i)
    return { minPrice: parsePrice(parts[0]), maxPrice: parsePrice(parts[1]) }
  }

  // "under $X" or "below $X" or "max $X" or "budget of X" (with or without $)
  const underMatch = text.match(/(?:under|below|max|maximum|up to)\s+\$[\d.,]+[kKmM]?/i)
  if (underMatch) return { minPrice: null, maxPrice: parsePrice(underMatch[0]) }

  // "budget of X" or "budget X" — price may not have $ sign
  const budgetMatch = text.match(/budget\s+(?:of\s+)?\$?[\d.,]+[kKmM]?/i)
  if (budgetMatch) {
    const p = parsePrice(budgetMatch[0])
    if (p) return { minPrice: null, maxPrice: p }
  }

  // "over $X" or "above $X" or "min $X"
  const overMatch = text.match(/(?:over|above|min|minimum|at least)\s+\$[\d.,]+[kKmM]?/i)
  if (overMatch) return { minPrice: parsePrice(overMatch[0]), maxPrice: null }

  // "around $X" or "about $X" — treat as ±20% range
  const aroundMatch = text.match(/(?:around|about|~|approximately)\s+\$[\d.,]+[kKmM]?/i)
  if (aroundMatch) {
    const p = parsePrice(aroundMatch[0])
    if (p) return { minPrice: Math.round(p * 0.8), maxPrice: Math.round(p * 1.2) }
  }

  // Single $X — use as rough upper bound for rental queries, exact for sale
  const singleMatch = text.match(/\$[\d.,]+[kKmM]?/i)
  if (singleMatch) {
    const p = parsePrice(singleMatch[0])
    // If price < 50k it's probably monthly rent, else sale price
    if (p && p < 50_000) return { minPrice: null, maxPrice: p }
    if (p) return { minPrice: null, maxPrice: p }
  }

  return { minPrice: null, maxPrice: null }
}

function extractNeighborhoods(text: string): string[] {
  const lower = text.toLowerCase()
  const hits = new Set<string>()
  for (const { lower: variant, canonical } of VARIANT_INDEX) {
    if (hits.has(canonical)) continue            // already matched this canonical via a longer variant
    if (lower.includes(variant)) hits.add(canonical)
  }
  return [...hits]
}

function extractBoroughs(text: string): string[] {
  const lower = text.toLowerCase()
  return BOROUGHS.filter(b => lower.includes(b.toLowerCase()))
}

function detectRentalSale(text: string): boolean | null {
  const lower = text.toLowerCase()
  const rentalWords = ['rental','rent','renting','renter','lease','monthly','per month','/mo','for rent','landlord']
  const saleWords   = ['sale','buy','purchase','buying','listing','for sale','asking price','co-op','condo','townhouse']
  const r = rentalWords.some(w => lower.includes(w))
  const s = saleWords.some(w => lower.includes(w))
  if (r && !s) return true
  if (s && !r) return false
  return null
}

function detectCategorySignals(text: string): string[] {
  const lower = text.toLowerCase()
  const cats: string[] = []
  // "buyer ISO" / explicit ISO — NOT when Ryan is representing a client
  const agentHasBuyer =
    /(got|have|i'?ve?\s+got|representing|working\s+with)\s+a\s+(buyer|client|renter|investor)/i.test(lower) ||
    /\b(buyer|client|renter|investor)\s+of\s+mine\b/i.test(lower) ||
    /\bmy\s+(buyer|client|investor|renter)\b/i.test(lower)
  // "buyers in X" / "show me buyers" = BUYER_ISO (other agents' inbox demand), not supply listings
  if (!agentHasBuyer && /\bbuyers?\b/.test(lower)) cats.push('BUYER_ISO')
  if (!agentHasBuyer && /\brenters?\b/.test(lower)) cats.push('RENTER_INQUIRY')
  if (/off.?market|pocket listing/.test(lower)) cats.push('OFF_MARKET_SALE')
  if (/coming soon/.test(lower)) cats.push('COMING_SOON_SALE','COMING_SOON_RENTAL')
  if (/open house|broker preview/.test(lower)) cats.push('OPEN_HOUSE')
  if (/price.?drop|price.?reduction|price.?cut|reduced/.test(lower)) cats.push('PRICE_DROP')
  if (/back on market|back on the market/.test(lower)) cats.push('BACK_ON_MARKET')
  if (/seller lead|potential seller|wants to sell/.test(lower)) cats.push('SELLER_LEAD')
  if (/landlord lead|potential landlord/.test(lower)) cats.push('LANDLORD_LEAD')
  if (/development|new dev|sponsor unit/.test(lower)) cats.push('DEVELOPMENT_INVENTORY','SPONSOR_UNIT')
  if (/market report|market update|market data/.test(lower)) cats.push('MARKET_REPORT')
  if (/showing.{0,20}confirm|confirmed showing/.test(lower)) cats.push('SHOWING_CONFIRMATION')
  return [...new Set(cats)]
}

// ── Deterministic confidence: can we skip LLM? ───────────────────────────────
function deterministicConfidence(q: Omit<ParsedQuery, 'usedLLM' | 'confidence'>): number {
  let score = 0.5
  if (q.neighborhoods.length > 0)  score += 0.2
  if (q.beds !== null || q.minBeds !== null) score += 0.15
  if (q.minUnits !== null || q.maxUnits !== null) score += 0.1
  if (q.minPrice !== null || q.maxPrice !== null) score += 0.1
  if (q.categories.length > 0)     score += 0.15
  if (q.intent !== 'general')      score += 0.1
  return Math.min(score, 0.95)
}

// ── LLM fallback (only when deterministic confidence < 0.65) ─────────────────
const LLM_SYSTEM = `You are a NYC real estate query parser. Extract structured search criteria from a user's natural language query.

Return ONLY valid JSON (no markdown):
{
  "neighborhoods": string[],   // NYC neighborhood names exactly as listed
  "boroughs": string[],        // Manhattan, Brooklyn, Queens, Bronx, Staten Island
  "beds": number|null,         // exact bed count (0=studio)
  "minBeds": number|null,
  "maxBeds": number|null,
  "minUnits": number|null,     // for "N-family" / "multi-family" / "N-unit" queries — N means N residential units in the building, NOT N bedrooms
  "maxUnits": number|null,
  "minPrice": number|null,     // as a number (e.g. 1500000, not "$1.5M")
  "maxPrice": number|null,
  "isRental": boolean|null,    // true=rental, false=sale, null=unclear
  "categories": string[],      // from: BUYER_ISO, RENTER_INQUIRY, OFF_MARKET_SALE, ACTIVE_SALE_LISTING, RENTAL_LISTING, COMING_SOON_SALE, COMING_SOON_RENTAL, OPEN_HOUSE, PRICE_DROP, BACK_ON_MARKET, SELLER_LEAD, LANDLORD_LEAD, DEVELOPMENT_INVENTORY, SHOWING_CONFIRMATION, MARKET_REPORT
  "isCalendar": boolean,
  "isACRIS": boolean,
  "isDOB": boolean
}

Examples:
"2BR rentals in Williamsburg" → beds:2, isRental:true, neighborhoods:["Williamsburg"]
"anything for my Brooklyn investor?" → boroughs:["Brooklyn"], isRental:false
"who owns 123 West 57th?" → isACRIS:true
"buyer ISOs for Tribeca" → categories:["BUYER_ISO"], neighborhoods:["Tribeca"]
"got a buyer looking for 3BR in Clinton Hill, anything coming soon?" → categories:["COMING_SOON_SALE"], neighborhoods:["Clinton Hill"], minBeds:3, isRental:false
"have a buyer for Brooklyn townhouse" → boroughs:["Brooklyn"], isRental:false, categories:[]
"2-3 family in Bed-Stuy under 2M" → minUnits:2, maxUnits:3, neighborhoods:["Bed-Stuy"], maxPrice:2000000, isRental:false
"single family in Park Slope" → minUnits:1, maxUnits:1, neighborhoods:["Park Slope"], isRental:false`

async function llmParse(query: string): Promise<Partial<ParsedQuery>> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  try {
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: LLM_SYSTEM },
        { role: 'user',   content: `Parse this query: "${query}"` },
      ],
      temperature: 0,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    })
    const raw = res.choices[0].message.content ?? '{}'
    return JSON.parse(raw) as Partial<ParsedQuery>
  } catch {
    return {}
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function parseQuery(query: string): Promise<ParsedQuery> {
  const text = query.trim()

  // Deterministic pass
  const neighborhoods = extractNeighborhoods(text)
  const boroughs      = extractBoroughs(text)
  const bedResult     = extractBeds(text)
  const unitsResult   = extractUnits(text)
  const priceResult   = extractPrices(text)
  const categories    = detectCategorySignals(text)
  const isRental      = detectRentalSale(text)
  const lower         = text.toLowerCase()
  const isCalendar    = /\b(schedule|book|calendar|appointment|today|tomorrow|this week|next week|monday|tuesday|wednesday|thursday|friday)\b/.test(lower)
  const isACRIS       = /\b(who owns|acris|deed|sold for|ownership|mortgage|lien)\b/.test(lower)
  const isDOB         = /\b(permit|violation|dob|building department|air rights|certificate of occupancy|co |c\.o\.)\b/.test(lower)
  const isMyBuyer       = MY_BUYER_PATTERN.test(lower)
  const isSellerLead    = SELLER_LEAD_PATTERN.test(lower)
  const isEmailCampaign = EMAIL_CAMPAIGN_PATTERN.test(lower)
  const broaden         = BROADEN_PATTERNS.test(lower)

  const partial: Omit<ParsedQuery, 'usedLLM' | 'confidence'> = {
    raw: text,
    neighborhoods,
    boroughs,
    ...bedResult,
    ...unitsResult,
    ...priceResult,
    isRental,
    categories,
    intent: classifyIntent({ neighborhoods, boroughs, categories, isCalendar, isACRIS, isDOB, raw: text }),
    isCalendar,
    isACRIS,
    isDOB,
    isMyBuyer,
    isSellerLead,
    isEmailCampaign,
    broaden,
  }

  const detConf = deterministicConfidence(partial)

  // Force LLM fallback when the query syntactically references a place but our
  // deterministic neighborhood list didn't catch it. Common for shorthand:
  // bedstuy, fidi, lic, ues, uws, nomad, hk, etc. Cheaper than maintaining a
  // per-area alias map (GPT-4o-mini handles normalization for ~$0.0001/call).
  const hasLocationPhrase = /\b(in|near|around)\s+[a-z][a-z\- ]{2,}/i.test(text)
  if (hasLocationPhrase && neighborhoods.length === 0 && boroughs.length === 0) {
    // fall through to LLM regardless of detConf
  } else if (detConf >= 0.65) {
    return { ...partial, usedLLM: false, confidence: detConf }
  }

  // LLM fallback for ambiguous queries
  const llmResult = await llmParse(text)

  const merged: Omit<ParsedQuery, 'usedLLM' | 'confidence'> = {
    raw:           text,
    neighborhoods: [...new Set([...neighborhoods, ...(llmResult.neighborhoods ?? [])])],
    boroughs:      [...new Set([...boroughs,      ...(llmResult.boroughs ?? [])])],
    beds:          bedResult.beds          ?? llmResult.beds          ?? null,
    minBeds:       bedResult.minBeds       ?? llmResult.minBeds       ?? null,
    maxBeds:       bedResult.maxBeds       ?? llmResult.maxBeds       ?? null,
    minUnits:      unitsResult.minUnits    ?? llmResult.minUnits      ?? null,
    maxUnits:      unitsResult.maxUnits    ?? llmResult.maxUnits      ?? null,
    minPrice:      priceResult.minPrice    ?? llmResult.minPrice      ?? null,
    maxPrice:      priceResult.maxPrice    ?? llmResult.maxPrice      ?? null,
    isRental:      isRental                ?? llmResult.isRental      ?? null,
    categories:    [...new Set([...categories, ...(llmResult.categories ?? [])])],
    isCalendar:    isCalendar || (llmResult.isCalendar ?? false),
    isACRIS:       isACRIS    || (llmResult.isACRIS    ?? false),
    isDOB:         isDOB      || (llmResult.isDOB      ?? false),
    isMyBuyer,
    isSellerLead,
    isEmailCampaign,
    broaden,
    intent: classifyIntent({
      neighborhoods: [...new Set([...neighborhoods, ...(llmResult.neighborhoods ?? [])])],
      boroughs:      [...new Set([...boroughs,      ...(llmResult.boroughs ?? [])])],
      categories:    [...new Set([...categories,    ...(llmResult.categories ?? [])])],
      isCalendar:    isCalendar || (llmResult.isCalendar ?? false),
      isACRIS:       isACRIS    || (llmResult.isACRIS    ?? false),
      isDOB:         isDOB      || (llmResult.isDOB      ?? false),
      raw:           text,
    }),
  }

  return { ...merged, usedLLM: true, confidence: 0.8 }
}

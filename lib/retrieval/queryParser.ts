import OpenAI from 'openai'
import { classifyIntent } from './intentClassifier'
import type { ParsedQuery, IntentBucket } from './types'

// ── NYC neighborhood list (deterministic matching) ────────────────────────────
const NYC_NEIGHBORHOODS: string[] = [
  // Manhattan
  'Tribeca','SoHo','NoHo','NoMad','Flatiron','Chelsea','West Village','Greenwich Village',
  'East Village','Lower East Side','Financial District','Battery Park City','Hudson Yards',
  "Hell's Kitchen","Clinton","Midtown","Midtown West","Midtown East","Murray Hill","Kips Bay",
  'Gramercy','Stuyvesant Town','Peter Cooper Village','Nolita','Little Italy','Chinatown',
  'Two Bridges','Upper West Side','Upper East Side','Harlem','East Harlem','Spanish Harlem',
  'Hamilton Heights','Washington Heights','Inwood','Yorkville','Carnegie Hill','Lenox Hill',
  'Morningside Heights','Manhattanville','Roosevelt Island',
  // Brooklyn
  'Williamsburg','Greenpoint','Bushwick','Bed-Stuy','Bedford-Stuyvesant','Crown Heights',
  'Park Slope','Carroll Gardens','Cobble Hill','Boerum Hill','Brooklyn Heights','DUMBO',
  'Fort Greene','Clinton Hill','Prospect Heights','Prospect Park South','Windsor Terrace',
  'Kensington','Flatbush','East Flatbush','Ditmas Park','Midwood','Marine Park',
  'Sheepshead Bay','Brighton Beach','Coney Island','Sunset Park','Bay Ridge',
  'Dyker Heights','Bensonhurst','Gravesend','Canarsie','Flatlands','East New York',
  'Brownsville','Red Hook','Gowanus','South Slope','Lefferts Gardens',
  // Queens
  'Astoria','Long Island City','LIC','Sunnyside','Woodside','Jackson Heights','Flushing',
  'Forest Hills','Rego Park','Elmhurst','Corona','Jamaica','Bayside','Fresh Meadows',
  'Howard Beach','Far Rockaway','Rockaway','Richmond Hill','St. Albans','Whitestone',
  'Douglaston','Little Neck',
  // Bronx
  'Riverdale','Fieldston','Woodlawn','Pelham Bay','City Island','Throgs Neck',
  'Morris Park','Fordham','Mott Haven','Hunts Point','Concourse',
  // Staten Island
  'St. George','Stapleton','Tottenville','Great Kills','Eltingville','New Dorp',
]

const NYC_BOROUGHS = ['Manhattan','Brooklyn','Queens','Bronx','Staten Island']

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

function extractPrices(text: string): { minPrice: number | null; maxPrice: number | null } {
  const lower = text.toLowerCase()

  // "$1.5M-$2M" or "$1.5M to $2M"
  const rangeMatch = text.match(/\$[\d.,]+[kKmM]?\s*(?:to|-)\s*\$[\d.,]+[kKmM]?/i)
  if (rangeMatch) {
    const parts = rangeMatch[0].split(/to|-/i)
    return { minPrice: parsePrice(parts[0]), maxPrice: parsePrice(parts[1]) }
  }

  // "under $X" or "below $X" or "max $X"
  const underMatch = text.match(/(?:under|below|max|maximum|up to)\s+\$[\d.,]+[kKmM]?/i)
  if (underMatch) return { minPrice: null, maxPrice: parsePrice(underMatch[0]) }

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
  return NYC_NEIGHBORHOODS.filter(n => lower.includes(n.toLowerCase()))
}

function extractBoroughs(text: string): string[] {
  const lower = text.toLowerCase()
  return NYC_BOROUGHS.filter(b => lower.includes(b.toLowerCase()))
}

function detectRentalSale(text: string): boolean | null {
  const lower = text.toLowerCase()
  const rentalWords = ['rental','rent','renting','renter','lease','monthly','per month','/mo','for rent','landlord']
  const saleWords   = ['sale','buy','purchase','buying','buyer','listing','for sale','asking price','co-op','condo','townhouse']
  const r = rentalWords.some(w => lower.includes(w))
  const s = saleWords.some(w => lower.includes(w))
  if (r && !s) return true
  if (s && !r) return false
  return null
}

function detectCategorySignals(text: string): string[] {
  const lower = text.toLowerCase()
  const cats: string[] = []
  if (/\biso\b|buyer.{0,10}iso|buyer.{0,10}looking|buyer.{0,10}need/.test(lower)) cats.push('BUYER_ISO')
  if (/renter.{0,10}(?:iso|looking|need|inquiry)|renter inquiry/.test(lower)) cats.push('RENTER_INQUIRY')
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
"buyer ISOs for Tribeca" → categories:["BUYER_ISO"], neighborhoods:["Tribeca"]`

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
  const priceResult   = extractPrices(text)
  const categories    = detectCategorySignals(text)
  const isRental      = detectRentalSale(text)
  const lower         = text.toLowerCase()
  const isCalendar    = /\b(schedule|book|calendar|appointment|today|tomorrow|this week|next week|monday|tuesday|wednesday|thursday|friday)\b/.test(lower)
  const isACRIS       = /\b(who owns|acris|deed|sold for|ownership|mortgage|lien)\b/.test(lower)
  const isDOB         = /\b(permit|violation|dob|building department|air rights|certificate of occupancy|co |c\.o\.)\b/.test(lower)

  const partial: Omit<ParsedQuery, 'usedLLM' | 'confidence'> = {
    raw: text,
    neighborhoods,
    boroughs,
    ...bedResult,
    ...priceResult,
    isRental,
    categories,
    intent: classifyIntent({ neighborhoods, boroughs, categories, isCalendar, isACRIS, isDOB, raw: text }),
    isCalendar,
    isACRIS,
    isDOB,
  }

  const detConf = deterministicConfidence(partial)

  // Skip LLM if deterministic parser is confident enough
  if (detConf >= 0.65) {
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
    minPrice:      priceResult.minPrice    ?? llmResult.minPrice      ?? null,
    maxPrice:      priceResult.maxPrice    ?? llmResult.maxPrice      ?? null,
    isRental:      isRental                ?? llmResult.isRental      ?? null,
    categories:    [...new Set([...categories, ...(llmResult.categories ?? [])])],
    isCalendar:    isCalendar || (llmResult.isCalendar ?? false),
    isACRIS:       isACRIS    || (llmResult.isACRIS    ?? false),
    isDOB:         isDOB      || (llmResult.isDOB      ?? false),
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

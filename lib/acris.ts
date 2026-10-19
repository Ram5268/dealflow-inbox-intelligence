// ACRIS — NYC Department of Finance property records via NYC Open Data (Socrata).
// No API key required. Three datasets:
//   Legals:  8h5j-fqxa  — address → document IDs + block/lot
//   Master:  bnx9-e6tj  — document IDs → doc type, date, sale amount
//   Parties: 636b-3b5g  — document IDs → buyer/seller names
import { fetchWithTimeout } from './chat/turnBudget'
import { NEIGHBORHOODS } from './domain/Neighborhood'

const BASE = 'https://data.cityofnewyork.us/resource'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PropertyTransfer {
  docType: string
  date: string
  price: number | null
  buyer: string | null
  seller: string | null
  documentId: string
}

export interface ACRISResult {
  inputAddress: string
  normalizedStreetNumber: string
  normalizedStreetName: string
  borough: string | null
  block: string | null
  lot: string | null
  currentOwner: string | null
  lastSaleDate: string | null
  lastSalePrice: number | null
  lastSaleSeller: string | null
  priorSaleDate: string | null
  priorSalePrice: number | null
  currentMortgageAmount: number | null
  currentMortgageDate: string | null
  currentMortgageLender: string | null
  isCoOp: boolean
  transfers: PropertyTransfer[]
  // Brief 43 PR 11 (Q16): other tax lots that matched the same street address
  // (condo units, a split lot, or, with no borough given, another borough's).
  // Their deeds are left out; see keepOneLot.
  otherLotsAtAddress: number
  // Brief 43 PR 11 review: the kept lot is one condo unit (lot 1001-6999),
  // not the whole building: its unit, or "lot 1002" when none is listed.
  condoUnit?: string | null
  fetchedAt: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

export type BoroughCode = '1' | '2' | '3' | '4' | '5'

export const BOROUGH_NAMES: Record<BoroughCode, string> = {
  '1': 'Manhattan', '2': 'Bronx', '3': 'Brooklyn', '4': 'Queens', '5': 'Staten Island',
}

const BOROUGH_CODE_BY_NAME: Record<string, BoroughCode> = {
  manhattan: '1', bronx: '2', brooklyn: '3', queens: '4', 'staten island': '5',
}

// Brief 43 PR 11 (Q16): when a chat message names no borough, zip or
// neighborhood, the city-records lookups search Brooklyn, where Ryan's CRM
// sellers are, and Drift is told the borough was assumed (lib/chat/context/
// cityRecordsAddress.ts). They never search every borough and merge the lots
// [engineering precaution].
export const ASSUMED_BOROUGH: BoroughCode = '3'

const STREET_TYPE_MAP: Record<string, string> = {
  st: 'STREET', 'st.': 'STREET', street: 'STREET',
  ave: 'AVENUE', 'ave.': 'AVENUE', av: 'AVENUE', avenue: 'AVENUE',
  blvd: 'BOULEVARD', 'blvd.': 'BOULEVARD', boulevard: 'BOULEVARD',
  pl: 'PLACE', 'pl.': 'PLACE', place: 'PLACE',
  dr: 'DRIVE', 'dr.': 'DRIVE', drive: 'DRIVE',
  rd: 'ROAD', 'rd.': 'ROAD', road: 'ROAD',
  ln: 'LANE', 'ln.': 'LANE', lane: 'LANE',
  ct: 'COURT', 'ct.': 'COURT', court: 'COURT',
  ter: 'TERRACE', 'ter.': 'TERRACE', terr: 'TERRACE', terrace: 'TERRACE',
  way: 'WAY', pkwy: 'PARKWAY', parkway: 'PARKWAY',
  hwy: 'HIGHWAY', highway: 'HIGHWAY', broadway: 'BROADWAY',
  // Brief 43 PR 11 (Q24)
  plz: 'PLAZA', plaza: 'PLAZA', cir: 'CIRCLE', circle: 'CIRCLE', sq: 'SQUARE', square: 'SQUARE',
  expy: 'EXPRESSWAY', expwy: 'EXPRESSWAY', expressway: 'EXPRESSWAY', concourse: 'CONCOURSE',
}

const COMPASS: Record<string, string> = {
  E: 'EAST', W: 'WEST', N: 'NORTH', S: 'SOUTH', EAST: 'EAST', WEST: 'WEST', NORTH: 'NORTH', SOUTH: 'SOUTH',
}

// Co-op property type codes in ACRIS Legals
// CP = Cooperative unit. SC = Residential Condo (NOT co-op).
const COOP_TYPES = new Set(['CP'])

// Document types that represent property sales/transfers
const DEED_TYPES = new Set(['DEED', 'DEED, TP', 'STED', 'DEET', 'RPTT', 'SPMT', 'DEED, RC'])

// Document types that represent mortgages
const MTG_TYPES = new Set(['MTGE', 'RMTG', 'MTGE, NY', 'AGMT'])

// ─── Address normalization ────────────────────────────────────────────────────

function removeOrdinals(s: string): string {
  return s.replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, '$1')
}

function normalizeStreetName(raw: string): string {
  // Brief 43 PR 11 (Q24): apostrophes go too ("St. Mark's" → "ST MARKS").
  const cleaned = removeOrdinals(raw.trim()).replace(/[.,'’]/g, '').toUpperCase()
  const words = cleaned.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  // Brooklyn's lettered avenues put the type first: "Ave J" → "AVENUE J".
  if (words.length === 2 && /^(?:AVENUE|AVE|AV)$/.test(words[0]) && /^[A-Z]$/.test(words[1])) {
    return `AVENUE ${words[1]}`
  }
  // A leading compass letter: "W 53 ST" → "WEST 53 STREET".
  if (words.length > 1 && /^[NSEW]$/.test(words[0])) words[0] = COMPASS[words[0]]
  const lastIdx = words.length - 1
  const last = words[lastIdx]
  const beforeLast = words[lastIdx - 1]?.toLowerCase()
  if (COMPASS[last] && words.length > 2 && beforeLast && STREET_TYPE_MAP[beforeLast]) {
    // A compass after the type: "PARK AVE S" → "PARK AVENUE SOUTH".
    words[lastIdx] = COMPASS[last]
    words[lastIdx - 1] = STREET_TYPE_MAP[beforeLast]
  } else if (COMPASS[last] && words.length > 1) {
    // The compass is the type: "CENTRAL PARK W" → "CENTRAL PARK WEST".
    words[lastIdx] = COMPASS[last]
  } else if (STREET_TYPE_MAP[last.toLowerCase()]) {
    // Expand the last word if it's a known abbreviation
    words[lastIdx] = STREET_TYPE_MAP[last.toLowerCase()]
  }
  return words.join(' ')
}

interface ParsedAddress {
  streetNumber: string
  streetName: string
  boroughCode: BoroughCode | null
}

export function parseAddress(input: string): ParsedAddress | null {
  const trimmed = input.trim()

  // Match: <house number>[<-unit>] <street part>[, <suffix with borough/neighborhood>]
  const m = trimmed.match(/^(\d+(?:-\d+)?)\s+(.+?)(?:\s*,\s*(.+))?$/)
  if (!m) return null

  const [, streetNumber, streetPart, suffix] = m
  // Brief 43 PR 11 (Q16): the suffix's borough, zip or neighborhood, read the
  // same way as in a chat message (findPlace).
  const place = suffix ? findPlace(suffix, { strict: false }) : null
  const boroughCode = place && place !== 'conflict' ? place.code : null

  const streetName = normalizeStreetName(streetPart)
  return { streetNumber, streetName, boroughCode }
}

// ─── Borough, zip and neighborhood in a message ──────────────────────────────
// Brief 43 PR 11 (Q16): the chat's deed and permit lookups used to drop the
// borough Ryan typed and search every borough, merging the deeds of every
// borough's same-numbered lot. These read it back [engineering precaution].

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A place name directly followed by a street word is a street ("Queens Blvd",
// "Jamaica Ave", Brooklyn's "Manhattan Ave"), not the place.
const STREET_WORDS = 'street|st|avenue|ave|av|road|rd|boulevard|blvd|place|pl|parkway|pkwy|expressway|expwy|expy|bridge|plaza|drive|dr|lane|ln|court|ct|terrace|ter|highway|hwy|square|sq|circle|walk'
const placeRe = (name: string) =>
  new RegExp(`(?<![a-z0-9'’-])${escapeRe(name)}(?![a-z0-9'’-])(?!\\s{1,3}(?:${STREET_WORDS})\\b)`)

const BOROUGH_WORDS: Array<{ re: RegExp; code: BoroughCode }> = ([
  ['manhattan', '1'], ['bronx', '2'], ['brooklyn', '3'], ['bklyn', '3'], ['bk', '3'], ['kings county', '3'],
  ['queens', '4'], ['staten island', '5'], ['richmond county', '5'],
] as Array<[string, BoroughCode]>).map(([name, code]) => ({ re: placeRe(name), code }))

// "New York, NY" is Manhattan's postal name; it counts only when nothing else
// names a place ("Brooklyn, New York" is Brooklyn; "New York City" is no borough).
const NEW_YORK = /(?<![a-z0-9])new york(?![a-z0-9])(?!\s{0,3}(?:city|state)\b)/

// Neighborhood names that are also everyday words or first names. They count
// right after an address ("418 Example St, Chelsea"), not elsewhere in a message.
const AMBIGUOUS_PLACE_WORDS = new Set([
  'madison', 'travis', 'clifton', 'woodrow', 'arlington', 'corona', 'hollis', 'melrose', 'chelsea',
  'kensington', 'riverside', 'concourse', 'jamaica', 'charleston', 'greenwood', 'woodstock', 'wakefield',
  'norwood', 'west side', 'the village',
])

// Every neighborhood spelling (lib/domain/Neighborhood.ts), longest first so
// "Brooklyn Heights" is read before "Brooklyn", plus Manhattan Beach (Brooklyn).
const NEIGHBORHOOD_WORDS: Array<{ name: string; canonical: string; code: BoroughCode; re: RegExp }> = (() => {
  const seen = new Set<string>()
  const out: Array<{ name: string; canonical: string; code: BoroughCode; re: RegExp }> = []
  const add = (variant: string, canonical: string, code: BoroughCode) => {
    const name = variant.toLowerCase()
    if (name.length < 3 || name.includes('&#') || seen.has(name)) return
    seen.add(name)
    out.push({ name, canonical, code, re: placeRe(name) })
  }
  for (const meta of Object.values(NEIGHBORHOODS)) {
    const code = BOROUGH_CODE_BY_NAME[meta.borough.toLowerCase()]
    for (const v of [meta.canonical, ...meta.variants]) add(v, meta.canonical, code)
  }
  add('Manhattan Beach', 'Manhattan Beach', '3')
  return out.sort((a, b) => b.name.length - a.name.length)
})()

/** The borough a NYC zip code is in, or null for a zip outside the five boroughs. */
export function boroughFromZip(zip: string): BoroughCode | null {
  const z = parseInt(zip, 10)
  if (z >= 10001 && z <= 10282) return '1'
  if (z >= 10301 && z <= 10314) return '5'
  if (z >= 10451 && z <= 10475) return '2'
  if (z >= 11201 && z <= 11256) return '3'
  if (z === 11004 || z === 11005 || (z >= 11101 && z <= 11120) || (z >= 11351 && z <= 11436) || (z >= 11691 && z <= 11697)) return '4'
  return null
}

interface Place { code: BoroughCode; label: string }

/**
 * The one borough a piece of text names, by borough name, then zip, then
 * neighborhood (word by word, never inside another word). 'conflict' when it
 * names two; null when none. `strict` skips the neighborhood names that are
 * also everyday words.
 */
function findPlace(text: string, opts: { strict: boolean }): Place | 'conflict' | null {
  let s = text.toLowerCase()
  const blank = (re: RegExp) => { s = s.replace(new RegExp(re.source, 'g'), m => ' '.repeat(m.length)) }

  const hoods: Array<{ canonical: string; code: BoroughCode }> = []
  for (const n of NEIGHBORHOOD_WORDS) {
    if (opts.strict && AMBIGUOUS_PLACE_WORDS.has(n.name)) continue
    if (n.re.test(s)) { hoods.push({ canonical: n.canonical, code: n.code }); blank(n.re) }
  }
  const named: BoroughCode[] = []
  for (const b of BOROUGH_WORDS) if (b.re.test(s)) { named.push(b.code); blank(b.re) }
  const zips: Array<{ zip: string; code: BoroughCode }> = []
  for (const m of s.matchAll(/(?<![\d$.,])\b(1[01]\d{3})\b(?![.,]?\d)/g)) {
    const code = boroughFromZip(m[1])
    if (code) zips.push({ zip: m[1], code })
  }

  const one = (codes: BoroughCode[]) => {
    const distinct = [...new Set(codes)]
    return distinct.length === 0 ? null : distinct.length === 1 ? distinct[0] : 'conflict'
  }
  const code = one(named) ?? one(zips.map(z => z.code)) ?? one(hoods.map(h => h.code)) ?? (NEW_YORK.test(s) ? '1' : null)
  if (code === null || code === 'conflict') return code

  // A label for the address string: "Bushwick, Brooklyn", "Brooklyn, NY 11221".
  const hood = hoods.find(h => h.code === code)
  const zip = zips.find(z => z.code === code)
  const label = `${hood ? `${hood.canonical}, ` : ''}${BOROUGH_NAMES[code]}${zip ? `, NY ${zip.zip}` : ''}`
  return { code, label }
}

// The street part of an address, as typed. Brief 43 PR 11 (Q24) added the
// forms that used to extract nothing: Rd, Ln, Ct, Ter, Parkway, Plaza, Circle,
// Sq, Hwy, "1500 Broadway" with no type, "St. Marks Pl", "W 53rd St", "Park
// Ave S", Brooklyn's "Ave J". Compass words appear two ways: as the street
// type itself ("Central Park West"), or after a normal street type ("Park
// Avenue South"). Words like "on", "in", "my" never sit inside a street name,
// so "my 2 sellers on Example Street" is not an address.
const NAME_STOP = '(?:on|in|at|for|and|or|with|to|my|is|are|was|a|an|the|who|what|that|this|near|by|from|of|it|its)'
const NAME_WORD = `(?!${NAME_STOP}\\b)(?:\\d+(?:st|nd|rd|th)?|[A-Za-z][A-Za-z'’.\\-]*)`
const COMPASS_PREFIX = '(?:(?:East|West|North|South|[EWNS]\\.?)\\s+)?'
const STREET_TYPES = 'Street|St|Avenue|Ave|Av|Place|Plaza|Plz|Pl|Drive|Dr|Road|Rd|Boulevard|Blvd|Lane|Ln|Court|Ct|Terrace|Terr|Ter|Way|Parkway|Pkwy|Circle|Cir|Square|Sq|Highway|Hwy|Expressway|Expwy|Expy|Concourse|Broadway|South|North|East|West'
const ADDRESS_PATTERN = new RegExp(
  '\\b(\\d+(?:-\\d+)?)\\s+(?:' +
    `(${COMPASS_PREFIX}(?:Broadway|Bowery))\\.?` +                                      // 2: "1500 Broadway"
    `|(${COMPASS_PREFIX}${NAME_WORD}(?:\\s+${NAME_WORD}){0,4}?)\\s+(${STREET_TYPES})\\.?` + // 3 name, 4 type
      '(?:\\s+(East|West|North|South|[NSEW])\\.?)?' +                                      // 5: trailing compass
    '|(Avenue|Ave|Av)\\.?\\s+([A-Z])' +                                                     // 6, 7: "Ave J"
  ")(?![A-Za-z0-9'’./\\-])",
  'i',
)

// Brief 43 PR 11 review: the run of place words right after a street: unit,
// borough, neighborhood, "NY", zip, joined by commas, spaces or "in"/"at"
// (", Apt 2, Brooklyn, NY 11221", " in Bed-Stuy"). It stops at the first
// other word, so "… for Travis" gives "" [engineering precaution].
const PLACE_AT_START = (() => {
  const names = [
    ...NEIGHBORHOOD_WORDS.map(n => n.name),
    'manhattan', 'bronx', 'brooklyn', 'bklyn', 'bk', 'kings county', 'queens', 'staten island', 'richmond county',
    'new york city', 'new york', 'nyc', 'n.y.', 'ny',
  ]
  const alts = [...new Set(names)].sort((a, b) => b.length - a.length).map(escapeRe).join('|')
  return new RegExp(`^(?:\\d{5}(?:-\\d{4})?(?!\\d)|(?:${alts})(?![a-z0-9'’-])(?!\\s{1,3}(?:${STREET_WORDS})\\b))`, 'i')
})()
const PLACE_JOIN = /^(?:\s*,\s*|\s+(?:in|at)\s+|\s+)(?:the\s+)?/i
const UNIT_AT_START = /^\s*,?\s*(?:(?:apt|apartment|unit|suite|ste|fl|floor|ph)(?![a-z])\.?\s*#?\s*[a-z0-9-]{1,6}|#\s*[a-z0-9-]{1,6})(?![a-z0-9])/i

// "or Queens", "and Brooklyn", "/ Queens", "vs. the Bronx" right after the place run.
const PLACE_ALTERNATIVE = /^\s*,?\s*(?:or|and|vs\.?|\/)\s*(?:the\s+)?/i

function placeAlternativeAfter(rest: string): ReturnType<typeof findPlace> {
  const join = PLACE_ALTERNATIVE.exec(rest)?.[0]
  if (!join) return null
  const place = PLACE_AT_START.exec(rest.slice(join.length))
  return place ? findPlace(place[0], { strict: true }) : null
}

function placeRunAfter(tail: string): string {
  let run = UNIT_AT_START.exec(tail)?.[0] ?? ''
  let found = false
  for (let i = 0; i < 6; i++) {
    const rest = tail.slice(run.length)
    const join = PLACE_JOIN.exec(rest)?.[0] ?? ''
    const place = PLACE_AT_START.exec(rest.slice(join.length))
    if (!place) break
    run += join + place[0]
    found = true
  }
  return found ? run : ''
}

export interface AddressInText {
  /** The street address as typed: "418 Marigold Street". */
  street: string
  /** The street plus the borough, zip or neighborhood typed with it: "418 Marigold Street, Brooklyn, NY 11221". */
  address: string
  boroughCode: BoroughCode | null
  /** Where the borough came from: typed with the address, elsewhere in the message, or the parsed query; 'conflict' when two boroughs were named. */
  boroughFrom: 'address' | 'message' | 'hint' | 'conflict' | null
}

/**
 * The first street address in a message, and its borough: typed right after
 * it ("…, Brooklyn", "…, NY 11221", "… Bushwick"), else named once elsewhere
 * in the message, else `hints.boroughs` (the parsed query's) unless that word is
 * the street's own ("Queens Blvd"). Null borough when none of those says.
 */
export function findAddressInText(text: string, hints: { boroughs?: string[] } = {}): AddressInText | null {
  const m = ADDRESS_PATTERN.exec(text)
  if (!m) return null
  const street = m[2] ? `${m[1]} ${m[2]}`
    : m[3] ? `${m[1]} ${m[3]} ${m[4]}${m[5] ? ` ${m[5]}` : ''}`
    : `${m[1]} ${m[6]} ${m[7]}`
  const end = m.index + m[0].length

  // The rest of the sentence after the street.
  const tail = text.slice(end).split(/[?!;\n]|\.(?=\s|$)/)[0].slice(0, 80)
  // Brief 43 PR 11 review: only the place words right after the street count
  // as typed with it (", Brooklyn, NY 11221", " in Bed-Stuy", " Apt 2, Queens").
  // A name later in the sentence ("… for Travis", "… my Queens buyer") is
  // elsewhere in the message. After "St." with no comma, the next word may
  // start a new sentence, so the first-name neighborhoods don't count there.
  // A borough typed with the address wins over one later in the sentence
  // ("418 Example St, Queens, for my Brooklyn buyer" is in Queens)
  // [engineering precaution].
  const lead = placeRunAfter(tail)
  const atAddress = lead ? findPlace(lead, { strict: m[0].endsWith('.') && !/^\s*,/.test(tail) }) : null
  // "…, Brooklyn or Queens?": a second borough offered as an alternative.
  const alternative = atAddress && atAddress !== 'conflict' ? placeAlternativeAfter(tail.slice(lead.length)) : null
  if (atAddress === 'conflict' || (atAddress && alternative && alternative !== 'conflict' && alternative.code !== atAddress.code) || alternative === 'conflict') {
    return { street, address: street, boroughCode: null, boroughFrom: 'conflict' }
  }
  if (atAddress) return { street, address: `${street}, ${atAddress.label}`, boroughCode: atAddress.code, boroughFrom: 'address' }

  const used = end + lead.length
  const rest = text.slice(0, m.index) + ' '.repeat(used - m.index) + text.slice(used)
  const inMessage = findPlace(rest, { strict: true })
  if (inMessage === 'conflict') return { street, address: street, boroughCode: null, boroughFrom: 'conflict' }
  if (inMessage) return { street, address: street, boroughCode: inMessage.code, boroughFrom: 'message' }

  const streetLower = street.toLowerCase()
  const hinted = [...new Set((hints.boroughs ?? [])
    .map(b => b.toLowerCase())
    .filter(b => !streetLower.includes(b))
    .map(b => BOROUGH_CODE_BY_NAME[b])
    .filter((c): c is BoroughCode => Boolean(c)))]
  if (hinted.length === 1) return { street, address: street, boroughCode: hinted[0], boroughFrom: 'hint' }
  return { street, address: street, boroughCode: null, boroughFrom: null }
}

// Extract the first street address found in a block of text, with the
// borough, zip or neighborhood typed right after it (Brief 43 PR 11: they used
// to be dropped).
export function extractAddressFromText(text: string): string | null {
  return findAddressInText(text)?.address ?? null
}

// Brief 43 PR 11 (Q25): sale questions ("when did … last sell", "what did it
// sell for", "has it sold"). Whole words, so "seller" doesn't count. A records
// lookup also needs an address in the message [engineering precaution].
export const SALE_WORDS = /\b(?:sell|sold)\b/i

// ─── Socrata API helpers ──────────────────────────────────────────────────────

// Brief 43 PR 4 (M32): each city-records fetch gives up after LOOKUP_TIMEOUT_MS
// (fetchWithTimeout's default) [engineering precaution].
async function socrataGet(dataset: string, params: Record<string, string>): Promise<unknown[]> {
  const qs = new URLSearchParams(params).toString()
  const url = `${BASE}/${dataset}.json?${qs}`
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`ACRIS API error ${res.status} on ${dataset}`)
  return res.json()
}

async function socrataWhere(dataset: string, where: string, limit = 200): Promise<unknown[]> {
  const url = `${BASE}/${dataset}.json?$where=${encodeURIComponent(where)}&$limit=${limit}`
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`ACRIS API error ${res.status} on ${dataset}`)
  return res.json()
}

// ─── ACRIS API calls ──────────────────────────────────────────────────────────

interface LegalRow {
  document_id: string
  borough: string
  block: string
  lot: string
  property_type: string
  street_number: string
  street_name: string
  unit?: string
}

interface MasterRow {
  document_id: string
  doc_type: string
  document_amt: string
  recorded_datetime: string
  document_date: string
}

interface PartyRow {
  document_id: string
  party_type: string  // "1" = grantor/seller, "2" = grantee/buyer
  name: string
}

function addOrdinal(streetName: string): string {
  // "WEST 75 STREET" → "WEST 75TH STREET"
  // Does NOT call normalizeStreetName (which would strip it right back off)
  return streetName.replace(/\b(\d+)\s+(STREET|AVENUE|PLACE|DRIVE|ROAD|BOULEVARD|LANE|COURT|TERRACE|WAY|PARKWAY)\b/, (_, n, type) => {
    const num = parseInt(n)
    const suffix = (num % 100 >= 11 && num % 100 <= 13) ? 'TH'
      : num % 10 === 1 ? 'ST'
      : num % 10 === 2 ? 'ND'
      : num % 10 === 3 ? 'RD'
      : 'TH'
    return `${n}${suffix} ${type}`
  })
}

async function fetchLegals(parsed: ParsedAddress): Promise<LegalRow[]> {
  const base: Record<string, string> = {
    street_number: parsed.streetNumber,
    $limit: '100',
  }
  if (parsed.boroughCode) base.borough = parsed.boroughCode

  // ACRIS is inconsistent — some records store "WEST 75 STREET", others "WEST 75TH STREET".
  // Try ordinal-stripped first, then ordinal-added as fallback.
  const withoutOrdinal = parsed.streetName
  const withOrdinal = addOrdinal(parsed.streetName)

  let results = await socrataGet('8h5j-fqxa', { ...base, street_name: withoutOrdinal }) as LegalRow[]
  if (results.length === 0 && withOrdinal !== withoutOrdinal) {
    results = await socrataGet('8h5j-fqxa', { ...base, street_name: withOrdinal }) as LegalRow[]
  }
  return results
}

async function fetchMaster(documentIds: string[]): Promise<MasterRow[]> {
  if (documentIds.length === 0) return []
  const ids = documentIds.slice(0, 50).map(id => `'${id}'`).join(',')
  return socrataWhere('bnx9-e6tj', `document_id IN (${ids})`, 200) as Promise<MasterRow[]>
}

async function fetchParties(documentIds: string[]): Promise<PartyRow[]> {
  if (documentIds.length === 0) return []
  const ids = documentIds.slice(0, 30).map(id => `'${id}'`).join(',')
  return socrataWhere('636b-3b5g', `document_id IN (${ids})`, 200) as Promise<PartyRow[]>
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const _cache = new Map<string, { data: ACRISResult; t: number }>()
const CACHE_TTL = 24 * 60 * 60 * 1000

// ─── Main lookup ──────────────────────────────────────────────────────────────

// Brief 43 PR 11 (Q16): one street address can match more than one tax lot:
// the same number and street in another borough (when no borough was given),
// a split or merged lot, condo units. Merging their deeds gave one building's
// "current owner" with another's "last sale". Keep one lot and count the others
// [engineering precaution].
//
// Brief 43 PR 11 review: the lot with the newest deed (then the newest filing,
// then the most filings), not the most filings: after a merger or split the
// old lot keeps decades of filings while the building now sits on the new one
// [engineering precaution].
function keepOneLot(legals: LegalRow[], master: MasterRow[]): { rows: LegalRow[]; otherLots: number } {
  const byLot = new Map<string, LegalRow[]>()
  for (const l of legals) {
    const key = `${l.borough}|${l.block}|${l.lot}`
    const rows = byLot.get(key)
    if (rows) rows.push(l)
    else byLot.set(key, [l])
  }
  const byId = new Map(master.map(m => [m.document_id, m]))
  const newest = (rows: LegalRow[], deedsOnly: boolean) => rows.reduce((best, l) => {
    const m = byId.get(l.document_id)
    if (!m || (deedsOnly && !isDeed(m))) return best
    const d = m.recorded_datetime ?? m.document_date ?? ''
    return d > best ? d : best
  }, '')
  let rows: LegalRow[] = []
  let key: [string, string, number] = ['', '', 0]
  for (const lotRows of byLot.values()) {
    const k: [string, string, number] = [newest(lotRows, true), newest(lotRows, false), lotRows.length]
    const better = k[0] !== key[0] ? k[0] > key[0] : k[1] !== key[1] ? k[1] > key[1] : k[2] > key[2]
    if (rows.length === 0 || better) { rows = lotRows; key = k }
  }
  return { rows, otherLots: byLot.size - 1 }
}

const isDeed = (m: MasterRow) => [...DEED_TYPES].some(t => m.doc_type?.toUpperCase().startsWith(t.split(',')[0]))

// Modern ACRIS document ids start with the recording date (YYYYMMDD…); older
// ones ("FT_…") sort after them. Used to send the newest ids first, since the
// Master lookup takes at most 50.
const newestIdFirst = (a: string, b: string) => {
  const da = /^\d{8}/.test(a), db = /^\d{8}/.test(b)
  return da !== db ? (da ? -1 : 1) : b.localeCompare(a)
}

// Brief 43 PR 11: what a deed lookup found. 'none' means the city records
// answered with nothing for that address (in that borough); 'failed' means a
// request failed or ran out of time, so nothing can be said either way.
export type PropertyRecords =
  | { status: 'found'; result: ACRISResult }
  | { status: 'none' }
  | { status: 'failed' }

/**
 * The deeds and mortgages for one address. `opts.boroughCode` (a chat lookup
 * always passes one) wins over a borough in the address text; with neither,
 * every borough is searched, and still only one lot is kept.
 */
export async function findPropertyRecords(address: string, opts: { boroughCode?: BoroughCode | null } = {}): Promise<PropertyRecords> {
  const parsed = parseAddress(address)
  if (!parsed) return { status: 'failed' }
  const searchBorough = opts.boroughCode ?? parsed.boroughCode

  const cacheKey = `${searchBorough ?? '*'}|${address.toLowerCase().trim()}`
  const cached = _cache.get(cacheKey)
  if (cached && Date.now() - cached.t < CACHE_TTL) return { status: 'found', result: cached.data }

  // Step 1: Get document IDs + block/lot from Legals
  let legals: LegalRow[] = []
  try {
    legals = await fetchLegals({ ...parsed, boroughCode: searchBorough })
  } catch (e) {
    console.error('[ACRIS] Legals fetch failed:', (e as Error).message)
    return { status: 'failed' }
  }

  // Brief 43 PR 11 (Q16): never another borough's lot, even if the answer has one.
  if (searchBorough) legals = legals.filter(l => String(l.borough) === searchBorough)
  if (legals.length === 0) return { status: 'none' }

  // Step 2: Get document metadata from Master (every matching lot's, newest
  // first, so the lot can be picked by date; still one request).
  let allMaster: MasterRow[] = []
  try {
    allMaster = await fetchMaster([...new Set(legals.map(l => l.document_id))].sort(newestIdFirst))
  } catch (e) {
    console.error('[ACRIS] Master fetch failed:', (e as Error).message)
    return { status: 'failed' }
  }

  // Brief 43 PR 11 (Q16): one lot only.
  const { rows: lotLegals, otherLots } = keepOneLot(legals, allMaster)

  const docIds = new Set(lotLegals.map(l => l.document_id))

  // Detect co-op from property type codes
  const isCoOp = lotLegals.some(l => COOP_TYPES.has(l.property_type))

  // Extract block/lot from the kept lot
  const firstLegal = lotLegals[0]
  const block = firstLegal.block ?? null
  const lot = firstLegal.lot ?? null
  const boroughCode = firstLegal.borough ?? searchBorough ?? null
  const lotNumber = parseInt(String(lot ?? ''), 10)
  const unitName = lotLegals.map(l => l.unit?.trim()).find(Boolean)
  const condoUnit = otherLots > 0 && lotNumber >= 1001 && lotNumber <= 6999
    ? (unitName ? `unit ${unitName}` : `lot ${lotNumber}`)
    : null

  const master = allMaster.filter(m => docIds.has(m.document_id))

  // Filter to deeds and mortgages, sort by date descending
  const deeds = master
    .filter(isDeed)
    .sort((a, b) => (b.recorded_datetime ?? '').localeCompare(a.recorded_datetime ?? ''))

  const mortgages = master
    .filter(m => [...MTG_TYPES].some(t => m.doc_type?.toUpperCase().startsWith(t.split(',')[0])))
    .sort((a, b) => (b.recorded_datetime ?? '').localeCompare(a.recorded_datetime ?? ''))

  // Step 3: Get buyer/seller names from Parties (for deed documents only)
  const deedIds = deeds.slice(0, 10).map(d => d.document_id)
  const mtgIds = mortgages.slice(0, 5).map(m => m.document_id)
  const partyDocIds = [...new Set([...deedIds, ...mtgIds])]

  let parties: PartyRow[] = []
  try {
    parties = await fetchParties(partyDocIds)
  } catch (e) {
    console.error('[ACRIS] Parties fetch failed:', (e as Error).message)
  }

  // Build party lookup map: documentId → { buyer, seller }
  const partyMap = new Map<string, { buyer: string | null; seller: string | null }>()
  for (const p of parties) {
    const entry = partyMap.get(p.document_id) ?? { buyer: null, seller: null }
    const name = p.name?.trim() || null
    if (p.party_type === '2') entry.buyer = name    // grantee/buyer
    if (p.party_type === '1') entry.seller = name   // grantor/seller
    partyMap.set(p.document_id, entry)
  }

  // Assemble transfer history from deeds
  const transfers: PropertyTransfer[] = deeds.slice(0, 10).map(d => {
    const pts = partyMap.get(d.document_id)
    const rawAmt = parseFloat(d.document_amt ?? '0')
    const price = rawAmt > 100 ? rawAmt : null  // ignore nominal $10 co-op transfers
    return {
      docType: d.doc_type ?? '',
      date: d.recorded_datetime?.slice(0, 10) ?? d.document_date?.slice(0, 10) ?? '',
      price,
      buyer: pts?.buyer ?? null,
      seller: pts?.seller ?? null,
      documentId: d.document_id,
    }
  })

  // Most recent deed with a real price
  const lastDeed = transfers.find(t => t.price !== null) ?? transfers[0] ?? null
  const priorDeed = transfers.find((t, i) => i > 0 && t.price !== null) ?? null

  // Current owner: buyer on the most recent deed
  const currentOwner = lastDeed?.buyer ?? null

  // Most recent mortgage
  const latestMtg = mortgages[0] ?? null
  const mtgParties = latestMtg ? partyMap.get(latestMtg.document_id) : null
  const mtgAmt = latestMtg ? parseFloat(latestMtg.document_amt ?? '0') : 0

  const result: ACRISResult = {
    inputAddress: address,
    normalizedStreetNumber: parsed.streetNumber,
    normalizedStreetName: parsed.streetName,
    borough: boroughCode,
    block,
    lot,
    currentOwner,
    lastSaleDate: lastDeed?.date ?? null,
    lastSalePrice: lastDeed?.price ?? null,
    lastSaleSeller: lastDeed?.seller ?? null,
    priorSaleDate: priorDeed?.date ?? null,
    priorSalePrice: priorDeed?.price ?? null,
    currentMortgageAmount: mtgAmt > 0 ? mtgAmt : null,
    currentMortgageDate: latestMtg?.recorded_datetime?.slice(0, 10) ?? null,
    currentMortgageLender: mtgParties?.buyer ?? null,
    isCoOp,
    transfers,
    otherLotsAtAddress: otherLots,
    condoUnit,
    fetchedAt: new Date().toISOString(),
  }

  _cache.set(cacheKey, { data: result, t: Date.now() })
  return { status: 'found', result }
}

export async function lookupProperty(address: string, opts: { boroughCode?: BoroughCode | null } = {}): Promise<ACRISResult | null> {
  const found = await findPropertyRecords(address, opts)
  return found.status === 'found' ? found.result : null
}

// ─── Format for chat context ──────────────────────────────────────────────────

export function formatForChat(r: ACRISResult): string {
  const lines: string[] = [`ACRIS PROPERTY RECORDS — ${r.inputAddress}`]

  if (r.currentOwner) lines.push(`Current owner: ${r.currentOwner}`)

  if (r.isCoOp) {
    lines.push('Note: Co-op unit — deed prices reflect share transfers (often nominal $10), not market value')
  }

  if (r.lastSaleDate) {
    const price = r.lastSalePrice ? `$${r.lastSalePrice.toLocaleString()}` : 'price not recorded (co-op or nominal transfer)'
    lines.push(`Last sale: ${r.lastSaleDate} for ${price}${r.lastSaleSeller ? ` (sold by ${r.lastSaleSeller})` : ''}`)
  }

  if (r.priorSaleDate && r.priorSalePrice) {
    lines.push(`Prior sale: ${r.priorSaleDate} for $${r.priorSalePrice.toLocaleString()}`)
  }

  if (r.currentMortgageAmount) {
    lines.push(`Recorded mortgage: $${r.currentMortgageAmount.toLocaleString()} (${r.currentMortgageDate ?? 'date unknown'})${r.currentMortgageLender ? ` — ${r.currentMortgageLender}` : ''}`)
  }

  if (r.block && r.lot) {
    const boroughName = BOROUGH_NAMES[(r.borough ?? '') as BoroughCode] ?? ''
    lines.push(`BBL: ${boroughName} Block ${r.block} Lot ${r.lot}`)
  }

  // Brief 43 PR 11 (Q16): say when other lots share the address, so Drift
  // doesn't present one lot's records as the whole address's.
  const others = r.otherLotsAtAddress ?? 0
  if (others > 0 && r.condoUnit) {
    // Brief 43 PR 11 review: a condo's owner is per unit [engineering precaution].
    lines.push(`Note: this address is a condo building with ${others + 1} or more unit lots. These records are for one unit (${r.condoUnit}), not the whole building: don't call this owner the building's owner, and ask Ryan which unit he means.`)
  } else if (others > 0) {
    lines.push(`Note: ${others} other tax lot${others === 1 ? ' shares' : 's share'} this street address (for example a split or merged lot); these records are for the lot with the newest deed.`)
  }

  return lines.join('\n')
}

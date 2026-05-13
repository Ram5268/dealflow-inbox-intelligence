// ACRIS — NYC Department of Finance property records via NYC Open Data (Socrata).
// No API key required. Three datasets:
//   Legals:  8h5j-fqxa  — address → document IDs + block/lot
//   Master:  bnx9-e6tj  — document IDs → doc type, date, sale amount
//   Parties: 636b-3b5g  — document IDs → buyer/seller names

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
  fetchedAt: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

const BOROUGH_CODES: Record<string, string> = {
  manhattan: '1', 'new york': '1',
  bronx: '2', 'the bronx': '2',
  brooklyn: '3', kings: '3',
  queens: '4',
  'staten island': '5', richmond: '5',
}

// Neighborhoods that imply a borough when no explicit borough is named
const NEIGHBORHOOD_BOROUGH: Record<string, string> = {
  'upper east side': '1', 'upper west side': '1', 'midtown': '1',
  'chelsea': '1', 'tribeca': '1', 'soho': '1', 'harlem': '1',
  'greenwich village': '1', 'east village': '1', 'west village': '1',
  'flatiron': '1', 'gramercy': '1', 'murray hill': '1', 'kips bay': '1',
  'hell\'s kitchen': '1', 'lincoln square': '1', 'yorkville': '1',
  'washington heights': '1', 'inwood': '1',
  'williamsburg': '3', 'brooklyn heights': '3', 'park slope': '3',
  'dumbo': '3', 'cobble hill': '3', 'carroll gardens': '3',
  'bed-stuy': '3', 'bushwick': '3', 'greenpoint': '3', 'astoria': '4',
  'jackson heights': '4', 'flushing': '4', 'forest hills': '4',
  'long island city': '4', 'lic': '4', 'bayside': '4',
}

const STREET_TYPE_MAP: Record<string, string> = {
  st: 'STREET', 'st.': 'STREET', street: 'STREET',
  ave: 'AVENUE', 'ave.': 'AVENUE', avenue: 'AVENUE',
  blvd: 'BOULEVARD', 'blvd.': 'BOULEVARD', boulevard: 'BOULEVARD',
  pl: 'PLACE', 'pl.': 'PLACE', place: 'PLACE',
  dr: 'DRIVE', 'dr.': 'DRIVE', drive: 'DRIVE',
  rd: 'ROAD', 'rd.': 'ROAD', road: 'ROAD',
  ln: 'LANE', 'ln.': 'LANE', lane: 'LANE',
  ct: 'COURT', 'ct.': 'COURT', court: 'COURT',
  ter: 'TERRACE', 'ter.': 'TERRACE', terrace: 'TERRACE',
  way: 'WAY', pkwy: 'PARKWAY', parkway: 'PARKWAY',
  hwy: 'HIGHWAY', highway: 'HIGHWAY', broadway: 'BROADWAY',
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
  const cleaned = removeOrdinals(raw.trim()).replace(/[.,]/g, '').toUpperCase()
  const words = cleaned.split(/\s+/).filter(Boolean)
  // Expand the last word if it's a known abbreviation
  const last = words[words.length - 1]?.toLowerCase()
  if (last && STREET_TYPE_MAP[last]) {
    words[words.length - 1] = STREET_TYPE_MAP[last]
  }
  return words.join(' ')
}

interface ParsedAddress {
  streetNumber: string
  streetName: string
  boroughCode: string | null
}

export function parseAddress(input: string): ParsedAddress | null {
  const trimmed = input.trim()

  // Match: <house number>[<-unit>] <street part>[, <suffix with borough/neighborhood>]
  const m = trimmed.match(/^(\d+(?:-\d+)?)\s+(.+?)(?:\s*,\s*(.+))?$/)
  if (!m) return null

  const [, streetNumber, streetPart, suffix] = m
  let boroughCode: string | null = null

  if (suffix) {
    const s = suffix.toLowerCase()
    for (const [name, code] of Object.entries(BOROUGH_CODES)) {
      if (s.includes(name)) { boroughCode = code; break }
    }
    if (!boroughCode) {
      for (const [hood, code] of Object.entries(NEIGHBORHOOD_BOROUGH)) {
        if (s.includes(hood)) { boroughCode = code; break }
      }
    }
  }

  const streetName = normalizeStreetName(streetPart)
  return { streetNumber, streetName, boroughCode }
}

// Extract the first street address found in a block of text
export function extractAddressFromText(text: string): string | null {
  const pattern = /\b(\d+(?:-\d+)?)\s+((?:(?:East|West|North|South)\s+)?\d*\s*[A-Za-z]+(?:\s+[A-Za-z]+){0,3}?)\s+(Street|Avenue|Place|Drive|Road|Boulevard|Lane|Court|Terrace|Way|Blvd|Ave\.?|St\.?|Dr\.?|Pl\.?|Pkwy|Broadway)\b/i
  const m = text.match(pattern)
  if (!m) return null
  return `${m[1]} ${m[2]} ${m[3]}`
}

// ─── Socrata API helpers ──────────────────────────────────────────────────────

async function socrataGet(dataset: string, params: Record<string, string>): Promise<unknown[]> {
  const qs = new URLSearchParams(params).toString()
  const url = `${BASE}/${dataset}.json?${qs}`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`ACRIS API error ${res.status} on ${dataset}`)
  return res.json()
}

async function socrataWhere(dataset: string, where: string, limit = 200): Promise<unknown[]> {
  const url = `${BASE}/${dataset}.json?$where=${encodeURIComponent(where)}&$limit=${limit}`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
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

export async function lookupProperty(address: string): Promise<ACRISResult | null> {
  const cacheKey = address.toLowerCase().trim()
  const cached = _cache.get(cacheKey)
  if (cached && Date.now() - cached.t < CACHE_TTL) return cached.data

  const parsed = parseAddress(address)
  if (!parsed) return null

  // Step 1: Get document IDs + block/lot from Legals
  let legals: LegalRow[] = []
  try {
    legals = await fetchLegals(parsed)
  } catch (e) {
    console.error('[ACRIS] Legals fetch failed:', (e as Error).message)
    return null
  }

  if (legals.length === 0) return null

  const docIds = [...new Set(legals.map(l => l.document_id))]

  // Detect co-op from property type codes
  const isCoOp = legals.some(l => COOP_TYPES.has(l.property_type))

  // Extract block/lot from first legal record
  const firstLegal = legals[0]
  const block = firstLegal.block ?? null
  const lot = firstLegal.lot ?? null
  const boroughCode = firstLegal.borough ?? parsed.boroughCode ?? null

  // Step 2: Get document metadata from Master
  let master: MasterRow[] = []
  try {
    master = await fetchMaster(docIds)
  } catch (e) {
    console.error('[ACRIS] Master fetch failed:', (e as Error).message)
    return null
  }

  // Filter to deeds and mortgages, sort by date descending
  const deeds = master
    .filter(m => [...DEED_TYPES].some(t => m.doc_type?.toUpperCase().startsWith(t.split(',')[0])))
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
    fetchedAt: new Date().toISOString(),
  }

  _cache.set(cacheKey, { data: result, t: Date.now() })
  return result
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
    const boroughName = { '1':'Manhattan','2':'Bronx','3':'Brooklyn','4':'Queens','5':'Staten Island' }[r.borough ?? ''] ?? ''
    lines.push(`BBL: ${boroughName} Block ${r.block} Lot ${r.lot}`)
  }

  return lines.join('\n')
}

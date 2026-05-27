// Phase A — single source of truth for address normalization.
// Pure addition; no existing file imports this yet.
//
// Ports the comprehensive logic from lib/properties/normalizeAddress.ts (the
// canonical NYC street-address parser used by ACRIS lookup, SE matching, and
// duplicate detection) and adds:
//   - `raw` field (original input preserved for debugging)
//   - `normalized` is lowercase (the legacy `normalizedFull` was uppercase)
//   - `streetEasySlug` derivation (mirrors the slug logic in
//     lib/chat/streetEasyUrls.ts:buildStreetEasyBuildingUrl)
//
// Reproducibility note: the simpler regex normalizer in
// lib/ingestion/validator.ts (lines 14-30) returns a string that is:
//   lowercase + abbreviation-expanded + unit-stripped + sliced to 30 chars.
// This module's `normalizeAddress(raw).normalized` produces the same content
// minus the 30-char slice; call-sites that need the slice should apply
// `.slice(0, 30)` themselves. Phase B will migrate the validator to use this.

export interface NormalizedAddress {
  raw:            string         // original input, preserved verbatim
  normalized:     string         // canonical form for matching/lookup (lowercase, expanded suffixes, stripped unit)
  streetNumber:   string | null
  streetName:     string | null
  unit:           string | null
  streetEasySlug: string         // for URL building: "109-devoe-street"
}

// Street type expansions (match at end of street name)
const STREET_TYPES: Record<string, string> = {
  ST:   'STREET',
  AVE:  'AVENUE',
  AV:   'AVENUE',
  BLVD: 'BOULEVARD',
  BVLD: 'BOULEVARD',
  RD:   'ROAD',
  DR:   'DRIVE',
  PL:   'PLACE',
  CT:   'COURT',
  LN:   'LANE',
  PKWY: 'PARKWAY',
  PKY:  'PARKWAY',
  EXPY: 'EXPRESSWAY',
  HWY:  'HIGHWAY',
  BWAY: 'BROADWAY',
  TER:  'TERRACE',
  TERR: 'TERRACE',
  SQ:   'SQUARE',
}

// Direction expansions (match as prefix word)
const DIRECTIONS: Record<string, string> = {
  W:  'WEST',
  E:  'EAST',
  N:  'NORTH',
  S:  'SOUTH',
  NW: 'NORTHWEST',
  NE: 'NORTHEAST',
  SW: 'SOUTHWEST',
  SE: 'SOUTHEAST',
}

// Unit patterns to extract and strip from the main address
const UNIT_PATTERNS = [
  /,?\s+(?:APARTMENT|APT\.?)\s*([A-Z0-9-]+)$/i,
  /,?\s+(?:UNIT|SUITE|STE\.?)\s*([A-Z0-9-]+)$/i,
  /,?\s+(?:FLOOR|FL\.?)\s*([A-Z0-9-]+)$/i,
  /,?\s+(?:PH|PHC|PHD)\s*([A-Z0-9-]*)$/i,
  /,?\s+#([A-Z0-9-]+)$/i,
  /,?\s+(?:RM|ROOM)\s*([A-Z0-9-]+)$/i,
]

// Street-type regex used for slug derivation — keeps everything up to and
// including the last street type, drops trailing unit text.
const SLUG_STREET_TYPES = /\b(street|avenue|boulevard|road|drive|place|court|lane|terrace|circle|parkway|highway|st|ave|blvd|rd|dr|pl|ct|ln|ter|pkwy)\b\.?/gi

function extractUnit(address: string): { base: string; unit: string | null } {
  for (const pattern of UNIT_PATTERNS) {
    const m = address.match(pattern)
    if (m) {
      const unit = m[1]
        ? m[1].trim()
        : (address.match(pattern)?.[0]?.match(/PH[CD]?$/i)?.[0] ?? null)
      const base = address.slice(0, m.index).trim()
      return { base, unit: unit ?? null }
    }
  }
  return { base: address, unit: null }
}

function expandDirectionPrefix(streetName: string): string {
  return streetName.replace(/^([NESW]{1,2})\.?\s+/i, (_, dir) => {
    const expanded = DIRECTIONS[dir.toUpperCase()]
    return expanded ? expanded + ' ' : dir.toUpperCase() + ' '
  })
}

function stripOrdinals(streetName: string): string {
  // "57TH" → "57", "51ST" → "51" — so "W 57 St" and "W 57th St" both normalize the same way.
  return streetName.replace(/\b(\d+)(?:ST|ND|RD|TH)\b/gi, '$1')
}

function expandStreetType(streetName: string): string {
  return streetName.replace(/\s+([A-Z]+)\.?$/i, (_, abbr) => {
    const expanded = STREET_TYPES[abbr.toUpperCase()]
    return expanded ? ' ' + expanded : ' ' + abbr.toUpperCase()
  })
}

function stripCityStateZip(address: string): string {
  const parts = address.split(',')
  if (parts.length <= 1) return address.trim()
  const rest = parts.slice(1).join(',')
  if (
    /(?:ny|nj|ct|new york|brooklyn|queens|bronx|manhattan|staten island)\b/i.test(rest) ||
    /\b\d{5}\b/.test(rest)
  ) {
    return parts[0].trim()
  }
  return address.trim()
}

function deriveStreetEasySlug(streetNumber: string | null, streetName: string | null, rawAddress: string): string {
  // Prefer a built slug from the parsed parts; fall back to the raw address
  // when parsing produced nothing usable.
  let streetPart: string
  if (streetNumber && streetName) {
    streetPart = `${streetNumber} ${streetName}`
  } else {
    const typeMatches = [...rawAddress.matchAll(SLUG_STREET_TYPES)]
    if (typeMatches.length > 0) {
      const last = typeMatches[typeMatches.length - 1]
      streetPart = rawAddress.slice(0, (last.index ?? 0) + last[0].length).trim()
    } else {
      streetPart = rawAddress
    }
  }
  return streetPart
    .toLowerCase()
    .replace(/[.']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function normalizeAddress(raw: string | null | undefined): NormalizedAddress | null {
  if (!raw || raw.trim().length === 0) return null

  const rawInput = raw
  // 1. Uppercase + collapse whitespace (work in uppercase for the parsing,
  //    then downcase for the public `normalized` field).
  let addr = raw.trim().toUpperCase().replace(/\s+/g, ' ')

  // 2. Strip "..., New York, NY 10019" suffix
  addr = stripCityStateZip(addr)

  // 3. Extract unit
  const { base, unit } = extractUnit(addr)
  addr = base

  // 4. Extract leading street number (digits, optional letter, optional range)
  const numMatch = addr.match(/^(\d+[A-Z]?(?:-\d+[A-Z]?)?)\s+(.+)$/)

  if (!numMatch) {
    // No recognizable street number — return best-effort
    const normalized = addr.toLowerCase()
    return {
      raw:            rawInput,
      normalized,
      streetNumber:   null,
      streetName:     addr || null,
      unit,
      streetEasySlug: deriveStreetEasySlug(null, null, rawInput),
    }
  }

  const streetNumber = numMatch[1]
  let streetName = numMatch[2].trim()
  streetName = stripOrdinals(streetName)
  streetName = expandDirectionPrefix(streetName)
  streetName = expandStreetType(streetName)
  streetName = streetName.replace(/\.$/, '').trim()

  const normalizedUpper = `${streetNumber} ${streetName}`
  return {
    raw:            rawInput,
    normalized:     normalizedUpper.toLowerCase(),
    streetNumber,
    streetName,
    unit,
    streetEasySlug: deriveStreetEasySlug(streetNumber, streetName, rawInput),
  }
}

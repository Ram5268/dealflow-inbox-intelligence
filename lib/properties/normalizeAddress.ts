export interface NormalizedAddress {
  streetNumber: string
  streetName: string
  unitNumber: string | null
  normalizedFull: string   // canonical form used for DB matching: "123 WEST 57TH STREET"
}

// Street type expansions (match at end of street name)
const STREET_TYPES: Record<string, string> = {
  'ST':    'STREET',
  'AVE':   'AVENUE',
  'AV':    'AVENUE',
  'BLVD':  'BOULEVARD',
  'BVLD':  'BOULEVARD',
  'RD':    'ROAD',
  'DR':    'DRIVE',
  'PL':    'PLACE',
  'CT':    'COURT',
  'LN':    'LANE',
  'PKWY':  'PARKWAY',
  'PKY':   'PARKWAY',
  'EXPY':  'EXPRESSWAY',
  'HWY':   'HIGHWAY',
  'BWAY':  'BROADWAY',
  'TER':   'TERRACE',
  'TERR':  'TERRACE',
  'SQ':    'SQUARE',
}

// Direction expansions (match as prefix word before the street number is stripped)
const DIRECTIONS: Record<string, string> = {
  'W':  'WEST',
  'E':  'EAST',
  'N':  'NORTH',
  'S':  'SOUTH',
  'NW': 'NORTHWEST',
  'NE': 'NORTHEAST',
  'SW': 'SOUTHWEST',
  'SE': 'SOUTHEAST',
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

function extractUnit(address: string): { base: string; unit: string | null } {
  for (const pattern of UNIT_PATTERNS) {
    const m = address.match(pattern)
    if (m) {
      const unit = m[1] ? m[1].trim() : (address.match(pattern)?.[0]?.match(/PH[CD]?$/i)?.[0] ?? null)
      const base = address.slice(0, m.index).trim()
      return { base, unit: unit ?? null }
    }
  }
  return { base: address, unit: null }
}

function expandDirectionPrefix(streetName: string): string {
  // Expand if the first word is a lone direction abbreviation (with optional trailing period)
  return streetName.replace(/^([NESW]{1,2})\.?\s+/i, (_, dir) => {
    const expanded = DIRECTIONS[dir.toUpperCase()]
    return expanded ? expanded + ' ' : dir.toUpperCase() + ' '
  })
}

function stripOrdinals(streetName: string): string {
  // Strip ordinal suffixes from street numbers: "57TH" → "57", "51ST" → "51"
  // This ensures "W 57 St" and "W 57th St" both normalize to the same form.
  return streetName.replace(/\b(\d+)(?:ST|ND|RD|TH)\b/gi, '$1')
}

function expandStreetType(streetName: string): string {
  // Expand the last word if it's a known abbreviation
  return streetName.replace(/\s+([A-Z]+)\.?$/i, (_, abbr) => {
    const expanded = STREET_TYPES[abbr.toUpperCase()]
    return expanded ? ' ' + expanded : ' ' + abbr.toUpperCase()
  })
}

function stripCityStateZip(address: string): string {
  // Strip everything after the first comma that contains city/state/zip indicators
  // e.g. "123 W 57th St, New York, NY 10019" → "123 W 57th St"
  const parts = address.split(',')
  if (parts.length <= 1) return address.trim()

  // Heuristic: if the second segment contains state/zip patterns, strip from first comma
  const rest = parts.slice(1).join(',')
  if (/(?:ny|nj|ct|new york|brooklyn|queens|bronx|manhattan|staten island)\b/i.test(rest) ||
      /\b\d{5}\b/.test(rest)) {
    return parts[0].trim()
  }
  return address.trim()
}

export function normalizeAddress(raw: string): NormalizedAddress | null {
  if (!raw || raw.trim().length === 0) return null

  // 1. Uppercase, collapse whitespace
  let addr = raw.trim().toUpperCase().replace(/\s+/g, ' ')

  // 2. Strip city/state/zip suffix
  addr = stripCityStateZip(addr)

  // 3. Extract unit number
  const { base, unit } = extractUnit(addr)
  addr = base

  // 4. Extract street number (leading digits, optional letter suffix like "123A")
  const numMatch = addr.match(/^(\d+[A-Z]?(?:-\d+[A-Z]?)?)\s+(.+)$/)
  if (!numMatch) {
    // No recognizable street number — return best-effort
    return {
      streetNumber: '',
      streetName: addr,
      unitNumber: unit,
      normalizedFull: addr,
    }
  }

  const streetNumber = numMatch[1]
  let streetName = numMatch[2].trim()

  // 5. Strip ordinal suffixes so "57TH" and "57" both become "57"
  streetName = stripOrdinals(streetName)

  // 6. Expand direction prefix (W → WEST, W. → WEST, etc.)
  streetName = expandDirectionPrefix(streetName)

  // 7. Expand street type suffix (ST → STREET, AVE → AVENUE, etc.)
  streetName = expandStreetType(streetName)

  // 8. Remove trailing periods
  streetName = streetName.replace(/\.$/, '').trim()

  const normalizedFull = `${streetNumber} ${streetName}`

  return {
    streetNumber,
    streetName,
    unitNumber: unit,
    normalizedFull,
  }
}

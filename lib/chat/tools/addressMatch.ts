// Brief 43 PR 7 (Q11): a direct address means that address [engineering
// precaution; the finding's expected answer]. search_listings used a plain
// substring, so "88 Example Ave" also returned 188 Example Ave, and a
// shortened "88 Example" returned 88 Example St too.
//
// Now the house number must match exactly (88 never matches 188) and the street
// words must line up after lib/crm-sync/addressNormalize's normalizeStreet (case,
// punctuation, unit suffixes, ordinals, Ave = Avenue, St = Street). When Ryan
// gives the street type, it must match (Ave never matches St); a shorter ask
// ("88 Example") matches every street type, which is honest: Drift can't tell.
// The exact address sorts first.
import { normalizeStreet } from '@/lib/crm-sync/addressNormalize'

export interface StreetAddress {
  number: string | null // "88", Queens "31-14" as "3114"
  street: string[] // normalised words: ["example", "avenue"]
  // A building stored as a short range ("88-90 Example Ave") also answers either
  // end: ["88", "90"]. Read from a stored row only; an ask stays exact.
  alsoNumbers?: string[]
}

const HOUSE_NUMBER = /^\d+[a-z]?$/
// A house number inside the text: digits, a Queens hyphen ("31-14") or a short
// range ("88-90"), an optional letter ("88A"), then a street word or a numbered
// street ("5th"). An ordinal itself ("10th") is a street, never a house number.
const NUMBER_IN_TEXT = /(^|[^a-z0-9-])(\d+(?:-\d+)?[a-z]?)(?=\s{1,4}(?:[a-z]|\d+(?:st|nd|rd|th)\b))/gi
const DIRECTION = new Set(['n', 's', 'e', 'w', 'north', 'south', 'east', 'west'])

function tokens(part: string): string[] {
  return (normalizeStreet(part) ?? '').split(' ').filter(Boolean)
}

// Where the house number starts in one comma part, or -1. Words before it are
// a building name or unit ("PH 88 Example Ave", "The Example Building - 88
// Example Ave", "Apt 2 88 Example Ave"); a number right after a direction is
// a street name ("W 10 St").
function numberStart(part: string): number {
  for (const m of part.matchAll(NUMBER_IN_TEXT)) {
    const at = (m.index ?? 0) + m[1].length
    const before = part.slice(0, at).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).pop()
    if (before == null || !DIRECTION.has(before)) return at
  }
  return -1
}

// The street part of an address, starting at its house number: the first
// comma-separated part that has one ("Apt 2, 88 Example Ave"), else the first part.
function streetPart(raw: string | null | undefined): string | null {
  const parts = (raw ?? '').split(',').map(p => p.trim()).filter(Boolean)
  for (const p of parts) {
    const at = numberStart(p)
    if (at >= 0) return p.slice(at)
  }
  return parts[0] ?? null
}

export function parseStreetAddress(raw: string | null | undefined): StreetAddress | null {
  const part = streetPart(raw)
  const words = part ? tokens(part) : []
  if (words.length === 0) return null
  if (HOUSE_NUMBER.test(words[0])) {
    // "88-90": both ends of the same parity, at most 10 apart (wider or mixed, like
    // Queens "21-36", is one house number).
    const range = (part ?? '').match(/^(\d+)-(\d+)\b/)
    const [a, b] = range ? [Number(range[1]), Number(range[2])] : [0, 0]
    const isRange = range != null && b > a && b - a <= 10 && a % 2 === b % 2
    return { number: words[0], street: words.slice(1), ...(isRange ? { alsoNumbers: [range[1], range[2]] } : {}) }
  }
  // normalizeStreet reads "St" as Saint only right after a house number.
  if (/^st\b/i.test(part ?? '') && words[0] === 'street') words[0] = 'saint'
  return { number: null, street: words }
}

// Street-type, direction and unit words: spelled several ways ("W", "West"), so
// they can't narrow a raw-text search.
const NOT_DISTINCTIVE = new Set([
  'st', 'str', 'street', 'ave', 'av', 'avenue', 'pl', 'place', 'rd', 'road', 'dr', 'drive', 'blvd', 'boulevard',
  'pkwy', 'parkway', 'ct', 'court', 'ln', 'lane', 'ter', 'terrace', 'hwy', 'highway', 'sq', 'square',
  'ft', 'fort', 'mt', 'mount', 'saint', 'n', 'north', 's', 'south', 'e', 'east', 'w', 'west',
  'apt', 'apartment', 'unit', 'ste', 'suite', 'fl', 'floor',
])
const distinctive = (w: string) => /^\d+$/.test(w) || (w.length >= 2 && !NOT_DISTINCTIVE.has(w))

// 'exact' when the street words are the same, 'partial' when one runs on past
// the other ("88 Example" vs "88 Example Ave", "... Ave 3B"), null otherwise.
// The row must reach the asked street's first distinctive word: "88 W" doesn't
// answer "88 W 10th St".
export function addressMatch(asked: StreetAddress, row: StreetAddress | null): 'exact' | 'partial' | null {
  if (!row) return null
  if (asked.number != null && row.number !== asked.number && !row.alsoNumbers?.includes(asked.number)) return null
  if (asked.street.length === 0) return 'partial'
  if (row.street.length < Math.max(1, asked.street.findIndex(distinctive) + 1)) return null
  const n = Math.min(asked.street.length, row.street.length)
  for (let i = 0; i < n; i++) if (asked.street[i] !== row.street[i]) return null
  return asked.street.length === row.street.length ? 'exact' : 'partial'
}

// One word for the database's case-insensitive `contains`: the first
// distinctive street word as Ryan typed it (ordinal ending dropped, "10th" -> "10";
// a final "s" dropped from longer words so "Marks" still finds "Mark's"), else
// the house number up to any hyphen. Every address addressMatch keeps contains
// it, so the database returns a superset and addressMatch decides.
export function addressSqlTerm(raw: string): string | null {
  const street = streetPart(raw) ?? ''
  const words = street.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const start = words.length > 0 && /^\d/.test(words[0]) ? (/^\d+$/.test(words[1] ?? '') && /-/.test(street) ? 2 : 1) : 0
  for (const w of words.slice(start)) {
    const word = w.replace(/^(\d+)(st|nd|rd|th)$/, '$1')
    if (!distinctive(word)) continue
    if (/^\d+$/.test(word)) return word
    return word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word
  }
  const num = street.trim().match(/^\d+/)
  return num ? num[0] : null
}

// The house number as a row's raw text can spell it, for a second `contains`
// (any one form): "3114" is stored as "3114" or "31-14" (normalizeStreet drops a
// hyphen between digits). Without it, a numbered street's one-word term ("5" for
// "88 5th Ave", "18" for "317 E 18th St") matches so many rows that the newest-500
// pool can hide the listing asked about. Every row addressMatch keeps contains
// one of these forms, so the database still returns a superset.
export function houseNumberSqlTerms(number: string | null): string[] {
  if (!number) return []
  const m = number.match(/^(\d+)(.*)$/)
  if (!m) return [number]
  const [, digits, rest] = m
  const forms = [number]
  for (let k = 1; k < digits.length; k++) forms.push(`${digits.slice(0, k)}-${digits.slice(k)}${rest}`)
  return forms
}

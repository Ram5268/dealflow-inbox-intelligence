// Brief 48 (PR 3, items 4.7 and 4.16b): what the Review Queue's "Correct" may
// change on a listing, and how what was typed becomes the listing's column types.
// The page's boxes are text boxes, and price and beds are Float columns, which
// Prisma refuses text for; before this, a price or beds correction failed while
// the item still left the queue. app/api/review/route.ts reads a correction here
// before it writes anything [engineering precaution]. Pure: no database.
import { Category } from '@prisma/client'
import { CATEGORY_LABELS } from '@/lib/utils'

type TextRule = { kind: 'text'; label: string; maxLength: number; required?: true }
type MoneyRule = { kind: 'money'; label: string }
type CountRule = {
  kind: 'count'; label: string; min: number; max: number
  step: 0.5 | 1 | null // whole or half numbers, whole numbers, or any
  example: string
  bedWords?: true      // also reads "3BR", "3 beds" and "Studio"
}
type CategoryRule = { kind: 'category'; label: string; required: true }
type FieldRule = TextRule | MoneyRule | CountRule | CategoryRule

const SHORT_TEXT = 300

// The 16 fields the route has always let a correction change. Each is an
// ExtractedOpportunity column of the matching type (prisma/schema.prisma, pinned
// by lib/review/__tests__/corrections.unit.test.ts). `status` is the listing's own
// status line from the email (for example "confirmed"), not the review item's.
export const CORRECTABLE_FIELDS = {
  address:          { kind: 'text', label: 'Address', maxLength: SHORT_TEXT },
  neighborhood:     { kind: 'text', label: 'Neighborhood', maxLength: SHORT_TEXT },
  borough:          { kind: 'text', label: 'Borough', maxLength: SHORT_TEXT },
  price:            { kind: 'money', label: 'Price' },
  minPrice:         { kind: 'money', label: 'Minimum price' },
  maxPrice:         { kind: 'money', label: 'Maximum price' },
  beds:             { kind: 'count', label: 'Beds', min: 0, max: 100, step: 0.5, example: '3, 2.5 or Studio', bedWords: true },
  baths:            { kind: 'count', label: 'Baths', min: 0, max: 100, step: 0.5, example: '2 or 1.5' },
  units:            { kind: 'count', label: 'Units', min: 1, max: 10_000, step: 1, example: '3' },
  squareFeet:       { kind: 'count', label: 'Square feet', min: 1, max: 10_000_000, step: null, example: '2400 or 2,400' },
  propertyType:     { kind: 'text', label: 'Property type', maxLength: SHORT_TEXT },
  availabilityDate: { kind: 'text', label: 'Availability date', maxLength: SHORT_TEXT },
  extractedTitle:   { kind: 'text', label: 'Title', maxLength: SHORT_TEXT, required: true },
  extractedSummary: { kind: 'text', label: 'Summary', maxLength: 4_000, required: true },
  category:         { kind: 'category', label: 'Category', required: true },
  status:           { kind: 'text', label: 'Listing status', maxLength: SHORT_TEXT },
} as const satisfies Record<string, FieldRule>

type Field = keyof typeof CORRECTABLE_FIELDS
type ValueOf<R> = R extends { kind: 'text' } ? string : R extends { kind: 'category' } ? Category : number
// null = the box was emptied: the value is removed (only where a listing may have none).
type Cleared<R> = R extends { required: true } ? never : null
export type ListingCorrections = { [K in Field]?: ValueOf<(typeof CORRECTABLE_FIELDS)[K]> | Cleared<(typeof CORRECTABLE_FIELDS)[K]> }

type Read<T> = { ok: true; value: T } | { ok: false; error: string }
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

// The plausible price range the email reader already flags outside of as a price
// problem (lib/ingestion/validator.ts), so a "Price issue" item can't be
// corrected to another implausible price [engineering precaution].
const PRICE_MIN = 500
const PRICE_MAX = 100_000_000
const MAX_TYPED = 40 // longer than any number a broker types

// "1250000", "1,250,000", "$1,250,000.00", "1.25M", "2.5mm", "950k". No sign, no
// exponent, commas only in groups of three.
const MONEY = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(k|mm|m)?$/i
const PLAIN = /^(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/
const BED_WORDS = /\s*(?:br|bd|beds?|bedrooms?)$/i
const CATEGORY_VALUES: ReadonlySet<string> = new Set(Object.values(Category))

const usd = (n: number) => `$${n.toLocaleString('en-US')}`

function readMoney(rule: MoneyRule, raw: unknown): Read<number> {
  const like = `${rule.label} must be a number, like 1250000, $1,250,000, 1.25M or 950k.`
  const negative = `${rule.label} can't be negative.`
  let value: number
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return fail(like)
    value = raw
  } else if (typeof raw === 'string') {
    const s = raw.trim()
    if (/^\$?\s*-/.test(s)) return fail(negative)
    const m = s.length <= MAX_TYPED ? MONEY.exec(s) : null
    if (!m) return fail(like)
    const n = Number(m[1].replace(/,/g, '') + (m[2] ?? ''))
    const unit = m[3]?.toLowerCase()
    // Rounded to the dollar, so 1.1M is 1,100,000 and not 1,100,000.0000000002.
    value = unit === 'k' ? Math.round(n * 1_000) : unit ? Math.round(n * 1_000_000) : n
  } else {
    return fail(like)
  }
  if (value < 0) return fail(negative)
  if (value < PRICE_MIN || value > PRICE_MAX) return fail(`${rule.label} must be between ${usd(PRICE_MIN)} and ${usd(PRICE_MAX)}.`)
  return { ok: true, value }
}

function readCount(rule: CountRule, raw: unknown): Read<number> {
  const like = `${rule.label} must be ${rule.step === 1 ? 'a whole number' : 'a number'}, like ${rule.example}.`
  const negative = `${rule.label} can't be negative.`
  let value: number
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return fail(like)
    value = raw
  } else if (typeof raw === 'string') {
    let s = raw.trim()
    if (s.length > MAX_TYPED) return fail(like)
    if (rule.bedWords) s = /^studio$/i.test(s) ? '0' : s.replace(BED_WORDS, '')
    if (s.startsWith('-')) return fail(negative)
    const m = PLAIN.exec(s)
    if (!m) return fail(like)
    value = Number(m[1].replace(/,/g, '') + (m[2] ?? ''))
  } else {
    return fail(like)
  }
  if (value < 0) return fail(negative)
  if (rule.step != null && !Number.isInteger(value / rule.step)) {
    return fail(`${rule.label} must be a ${rule.step === 1 ? 'whole' : 'whole or half'} number, like ${rule.example}.`)
  }
  if (value < rule.min || value > rule.max) {
    return fail(`${rule.label} must be between ${rule.min.toLocaleString('en-US')} and ${rule.max.toLocaleString('en-US')}.`)
  }
  return { ok: true, value }
}

function readText(rule: TextRule, raw: unknown): Read<string> {
  if (typeof raw !== 'string') return fail(`${rule.label} must be text.`)
  const s = raw.trim()
  if (s.length > rule.maxLength) return fail(`${rule.label} must be ${rule.maxLength.toLocaleString('en-US')} characters or fewer.`)
  return { ok: true, value: s }
}

function readCategory(rule: CategoryRule, raw: unknown): Read<Category> {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (CATEGORY_VALUES.has(s)) return { ok: true, value: s as Category }
  return fail(`${rule.label} must be one of DealFlow's categories: ${[...CATEGORY_VALUES].join(', ')}.`)
}

function readField(rule: FieldRule, raw: unknown): Read<string | number> {
  switch (rule.kind) {
    case 'text': return readText(rule, raw)
    case 'money': return readMoney(rule, raw)
    case 'count': return readCount(rule, raw)
    case 'category': return readCategory(rule, raw)
  }
}

// Reads a correction into the listing's column types, or refuses it with a
// plain-English message that names the field. A field the Review Queue doesn't
// correct is refused by name. The page sends only the boxes Ryan changed, and
// each box starts out showing the current value, so a box sent empty (or null)
// was emptied on purpose: that value is removed (null, never an empty string).
// Title, summary and category can't be removed, so an empty one is refused
// [engineering precaution].
export function parseCorrections(raw: unknown): { ok: true; fields: ListingCorrections } | { ok: false; error: string } {
  if (raw == null) return { ok: true, fields: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) return fail("The corrections couldn't be read. Send each field with its new value.")
  const fields: Record<string, string | number | null> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(CORRECTABLE_FIELDS, key)) return fail(`The Review Queue can't change "${key.slice(0, 40)}".`)
    const rule: FieldRule = CORRECTABLE_FIELDS[key as Field]
    if (value == null || (typeof value === 'string' && value.trim() === '')) {
      if ('required' in rule) return fail(`${rule.label} can't be left empty.`)
      fields[key] = null
      continue
    }
    const read = readField(rule, value)
    if (!read.ok) return read
    fields[key] = read.value
  }
  return { ok: true, fields: fields as ListingCorrections }
}

// Brief 48 (PR 3, item 4.16b): titles come from the AI email reader, so a
// category corrected by hand kept a title written for the old one. A new
// category gets a plain title: its label, the place (address, else
// neighborhood) and the beds when known. Nothing else goes in, so no names
// [engineering precaution].
export function titleForCategory(
  category: Category,
  listing: { address?: string | null; neighborhood?: string | null; beds?: number | null },
): string {
  const place = listing.address?.trim() || listing.neighborhood?.trim() || null
  const beds = listing.beds == null ? null : listing.beds === 0 ? 'Studio' : `${listing.beds}BR`
  return [CATEGORY_LABELS[category], place, beds].filter(Boolean).join(' · ')
}

// What a correction writes to the listing: its fields, plus a new title when the
// category changes and the correction doesn't give a title of its own. The new
// title uses the corrected (or removed) address, neighborhood and beds when those
// change too.
export function listingChanges(
  current: { category: Category; address: string | null; neighborhood: string | null; beds: number | null },
  fields: ListingCorrections,
): ListingCorrections {
  if (fields.category === undefined || fields.category === current.category || fields.extractedTitle !== undefined) return fields
  const after = <K extends 'address' | 'neighborhood' | 'beds'>(k: K) => (fields[k] !== undefined ? fields[k] : current[k])
  return {
    ...fields,
    extractedTitle: titleForCategory(fields.category, {
      address:      after('address'),
      neighborhood: after('neighborhood'),
      beds:         after('beds'),
    }),
  }
}

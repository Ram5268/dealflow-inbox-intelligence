// Brief 27.0 — shared formatting helpers for buyer-match sections. Anti-
// hallucination rule (CLAUDE.md): a field not on file is rendered "not on file",
// never invented.
import type { BuyerRecord } from '../../types'

export function money(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return 'not on file'
  return '$' + Math.round(n).toLocaleString('en-US')
}

export function priceRange(min: number | null, max: number | null): string {
  if (min == null && max == null) return 'not on file'
  if (min != null && max != null) return `${money(min)}–${money(max)}`
  if (min != null) return `${money(min)}+`
  return `up to ${money(max)}`
}

export function bedsLabel(min: number | null, max: number | null, exact: number | null): string {
  if (exact != null) return exact === 0 ? 'studio' : `${exact}BR`
  if (min == null && max == null) return 'any beds'
  if (min != null && max != null) return min === max ? `${min}BR` : `${min}–${max}BR`
  if (min != null) return `${min}BR+`
  return `up to ${max}BR`
}

// One-line human criteria summary, e.g. "Soho · 2BR · $4,250,000–$4,750,000".
export function criteriaLine(b: BuyerRecord): string {
  const parts: string[] = []
  const hood = b.neighborhoods.length ? b.neighborhoods.join(', ') : b.borough ?? 'no location on file'
  parts.push(hood)
  parts.push(bedsLabel(b.minBeds, b.maxBeds, b.beds))
  parts.push(priceRange(b.minPrice, b.maxPrice))
  return parts.join(' · ')
}

// Effective budget ceiling for math (max, else exact price, else null).
// Brief 48 PR 13 (review r2): `price` counts only when no range was given. mapISO
// fills it from a lone min or max, so a "$3,000+" renter (minPrice 3000) has no
// ceiling; reading that minimum as one said "up to $3,000" while the report's
// fit lines called the matches in budget (listingFitReason reads it the same way).
export function budgetCeiling(b: BuyerRecord): number | null {
  return b.maxPrice ?? (b.minPrice == null ? b.price : null)
}

// " The buyer's budget starts at $1,600,000, with no maximum on file." when only a
// minimum was given, else the plain "not on file" line (review r2).
export function noCeilingLine(b: BuyerRecord, who: string, amount: (n: number) => string): string {
  return b.minPrice != null
    ? ` The ${who}'s budget starts at ${amount(b.minPrice)}, with no maximum on file.`
    : ` The ${who}'s budget ${who === 'buyer' ? 'ceiling ' : ''}is not on file.`
}

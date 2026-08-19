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
export function budgetCeiling(b: BuyerRecord): number | null {
  return b.maxPrice ?? b.price ?? null
}

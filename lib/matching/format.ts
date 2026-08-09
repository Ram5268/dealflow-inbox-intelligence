// Brief 7.0 — human-readable one-liners for a party's criteria and a listing.
// Used both in the Sonnet tiering prompt and in the PartySummary/ListingSummary
// returned to callers, so the LLM and the UI describe a pair the same way.
import type { PartyContext, ListingContext } from './types'

function usd(n: number | null | undefined): string | null {
  if (n == null) return null
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`
  return `$${n}`
}

function priceRange(min: number | null, max: number | null): string | null {
  const lo = usd(min), hi = usd(max)
  if (lo && hi) return lo === hi ? lo : `${lo}–${hi}`
  if (lo) return `${lo}+`
  if (hi) return `up to ${hi}`
  return null
}

function bedRange(min: number | null, max: number | null): string | null {
  const b = (n: number) => (n === 0 ? 'studio' : `${n}BR`)
  if (min != null && max != null) return min === max ? b(min) : `${b(min)}–${b(max)}`
  if (min != null) return `${b(min)}+`
  if (max != null) return `up to ${b(max)}`
  return null
}

export function describeParty(p: PartyContext): string {
  const parts: string[] = []
  const hoods = p.neighborhoods.length ? p.neighborhoods.join('/') : (p.borough ?? 'anywhere')
  parts.push(hoods)
  const beds = bedRange(p.bedsMin, p.bedsMax)
  if (beds) parts.push(beds)
  const price = priceRange(p.budgetMin, p.budgetMax)
  if (price) parts.push(price)
  if (p.cashOnly) parts.push('cash')
  if (p.timing) parts.push(`(${p.timing})`)
  return `${p.role === 'buyer' ? 'Buyer' : 'Renter'}: ${parts.join(' ')}`
}

export function describeListing(l: ListingContext): string {
  const parts: string[] = []
  if (l.address) parts.push(l.address)
  const where = l.neighborhood ?? l.borough
  if (where) parts.push(where)
  if (l.beds != null) parts.push(l.beds === 0 ? 'studio' : `${l.beds}BR`)
  const price = usd(l.price)
  if (price) parts.push(price)
  return `${l.category} — ${parts.join(', ') || '(no details)'}`
}

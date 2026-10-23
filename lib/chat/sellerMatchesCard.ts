// Brief 43 PR 6 (N1; D11 [Ryan, 2026-10-18], by address D13 [Ryan,
// 2026-10-19]): the buyers DealFlow matched to ONE CRM seller Ryan named, as
// get_seller_matches returns them and as the structured card the chat page
// shows under Drift's reply. Buyers-for-a-seller questions are allowed under
// D11; the seller is always one Ryan named, never one of a list.
//
// Each buyer's /matches link travels as data, never in Drift's text: any URL
// there trips the guard (Q19). No server imports here, so the page can use
// these types and helpers too. PR 12 adds our estimate to the tool result's
// `seller` for Drift, never to this card (CONTRACT.md; lib/chat/valuation.ts).
import { HOT_MIN_FIT, WARM_MIN_FIT } from '@/lib/matching/tiers'

export type MatchTier = 'HOT' | 'WARM' | 'POSSIBLE'

// The seller: kind 'crm_seller', so Brief 43 PR 3's draft check knows this
// homeowner when Drift drafts a note to one of the buyers. No phone: a buyers
// question needs none (find_seller gives the contact).
export type SellerMatchesSeller = {
  kind: 'crm_seller'
  id: string
  name: string
  address: string | null
  neighborhood: string | null
  doNotContact: boolean
}

export type SellerMatchBuyer = {
  matchId: string
  tier: MatchTier
  score: number
  wants: string                 // "2–3 family · Bedford-Stuyvesant · 3+ BR · $1.35M–$2.6M · cash"
  fit: string                   // the homeowner-safe fit line (plainFitReason)
  isTestData: boolean
  matchesUrl: string            // "/matches?m=<id>"
}

export type SellerMatches = {
  seller: SellerMatchesSeller
  count: number                 // every match this seller has, not only the ones listed
  tiers: { hot: number; warm: number; possible: number }
  buyers: SellerMatchBuyer[]    // best first, at most 10
  matchesUrl: string | null     // the top match's link, as the CRM's "Open in DealFlow"
}

// As stored with the reply in dealsJson (no migration) and sent to the page.
export type SellerMatchesCard = SellerMatches & { kind: 'seller_matches' }

export function isSellerMatchesCard(x: unknown): x is SellerMatchesCard {
  return !!x && typeof x === 'object' && (x as { kind?: unknown }).kind === 'seller_matches'
    && Array.isArray((x as { buyers?: unknown }).buyers)
}

// The stored tier (the nightly's, lib/matching/nightly/select.ts tierOf), else
// the same thresholds (older rows have none), as the morning digest counts them.
export function tierOf(m: { tier: string | null; score: number }): MatchTier {
  if (m.tier === 'HOT' || m.tier === 'WARM' || m.tier === 'POSSIBLE') return m.tier
  return m.score >= HOT_MIN_FIT ? 'HOT' : m.score >= WARM_MIN_FIT ? 'WARM' : 'POSSIBLE'
}

// Brief 38: /matches?m=<id> opens that exact match, pinned at the top.
export const matchLink = (matchId: string) => `/matches?m=${encodeURIComponent(matchId)}`

// What a buyer asked for, read as the CRM card reads it (the CRM's BUYERS_SQL,
// copied in lib/importScoring/signals.ts): neighborhoods fall back to the one
// neighborhood, ranges to the single value, a CRM buyer's cashOnly is a cash buyer.
export type BuyerFacts = {
  neighborhoods: string[]
  propertyTypes: string[]
  bedsMin: number | null
  bedsMax: number | null
  priceMin: number | null
  priceMax: number | null
  buyerArchetype: string | null
}

// The line itself is the CRM card's buyerWants (src/lib/core-data/dealflow-sync/
// buyers.ts), so Drift, this card and the CRM card describe a buyer alike.
// DealFlow spells building types several ways ("2-Family", "Two-Family", "Duplex").
const FAMILY_SIZE: Record<string, number> = {
  '2-family': 2, 'two-family': 2, duplex: 2, '3-family': 3, 'three-family': 3, triplex: 3,
  '4-family': 4, 'four-family': 4, fourplex: 4, quadplex: 4,
}
const TYPE_WORD: Record<string, string> = {
  sfh: 'single-family', 'single-family': 'single-family', multifamily: 'multifamily',
  'multi-family': 'multifamily', coop: 'co-op', 'co-op': 'co-op',
}
const ARCHETYPE: Record<string, string> = {
  CASH_BUYER: 'cash', EXCHANGE_1031: '1031 exchange', TRADITIONAL_FINANCING: 'financed',
  INVESTOR_LANDLORD: 'investor', FIRST_TIME_FHA: 'first-time buyer (FHA)',
  LUXURY_ALL_CASH: 'luxury, all cash', LUXURY_FINANCED: 'luxury, financed',
}
export const NO_CRITERIA = 'Criteria not on file'

function typesText(types: string[]): string | null {
  const sizes = new Set<number>()
  const words = new Set<string>()
  for (const t of types) {
    const k = t.trim().toLowerCase()
    if (FAMILY_SIZE[k]) sizes.add(FAMILY_SIZE[k])
    else words.add(TYPE_WORD[k] ?? k)
  }
  const s = [...sizes].sort((a, b) => a - b)
  const run = s.length > 1 && s[s.length - 1] - s[0] === s.length - 1
  const family = run ? [`${s[0]}–${s[s.length - 1]} family`] : s.map(n => `${n}-family`)
  return [...family, ...words].join(', ') || null
}

const money = (n: number) =>
  n >= 1e6 ? `$${Number((n / 1e6).toFixed(2))}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`

function range(min: number | null, max: number | null, fmt: (n: number) => string): string | null {
  if (min != null && max != null) return min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`
  if (min != null) return `${fmt(min)}+`
  return max != null ? `up to ${fmt(max)}` : null
}

// "2–4 family · Bed-Stuy, Crown Heights · 3+ BR · $1.35M–$2.6M · cash"
export function buyerWants(b: BuyerFacts): string {
  const hoods = b.neighborhoods.length > 3 ? [...b.neighborhoods.slice(0, 3), `+${b.neighborhoods.length - 3}`] : b.neighborhoods
  const parts = [
    typesText(b.propertyTypes),
    hoods.join(', ') || null,
    range(b.bedsMin, b.bedsMax, String)?.concat(' BR'),
    range(b.priceMin, b.priceMax, money),
    b.buyerArchetype ? (ARCHETYPE[b.buyerArchetype] ?? b.buyerArchetype.toLowerCase().replace(/_/g, ' ')) : null,
  ]
  const line = parts.filter(Boolean).join(' · ')
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : NO_CRITERIA
}

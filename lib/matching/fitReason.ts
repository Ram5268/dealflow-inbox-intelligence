// Brief 41 (H7): the plain-English "why it fits" line for a match.
//
// It names only fit features (place, price, size, type, building). It never
// names the seller-side motivation signals the scorer also weighs (distress,
// equity, vacancy, absentee owner, tenure, lead lists): those must never reach
// a buyer, a report or an outreach draft. It never calls a drawback a strength,
// and it never names price when the seller's only price is our estimate.
import type { MatchFitResult } from './scorerTypes'

// A fit feature that raised the match.
const FIT_LABELS: Record<string, string> = {
  neighborhood: 'right neighborhood',
  price: 'in budget',
  beds: 'bedroom count',
  baths: 'bathrooms',
  propertyType: 'property type',
  carryingReasonableness: 'carrying costs',
  outdoorSpace: 'outdoor space',
  buildingAmenity: 'building amenities',
  substitutionScarcity: 'few alternatives for this buyer',
  buyerArchetypeSituation: "suits the buyer's strategy",
  recency: 'fresh listing',
}
// The same feature when it lowered the match.
const WEAK_LABELS: Record<string, string> = {
  neighborhood: 'location',
  price: 'price',
  beds: 'bedrooms',
  baths: 'bathrooms',
  propertyType: 'property type',
  carryingReasonableness: 'carrying costs',
  outdoorSpace: 'outdoor space',
  buildingAmenity: 'building amenities',
  substitutionScarcity: 'uniqueness',
  buyerArchetypeSituation: "fit with the buyer's strategy",
  recency: 'listing age',
}
// The same feature when the direction isn't known (older stored reasons).
const NEUTRAL_LABELS: Record<string, string> = {
  neighborhood: 'neighborhood',
  price: 'price',
  beds: 'bedrooms',
  baths: 'bathrooms',
  propertyType: 'property type',
  carryingReasonableness: 'carrying costs',
  outdoorSpace: 'outdoor space',
  buildingAmenity: 'building amenities',
  substitutionScarcity: 'scarcity of alternatives',
  buyerArchetypeSituation: "the buyer's strategy",
  recency: 'listing date',
}
// The scorer's seller-motivation features: never named.
export const MOTIVATION_KEYS: ReadonlySet<string> = new Set([
  'highEquity', 'freeAndClear', 'goldenHandcuff', 'absenteeOwner', 'vacancy',
  'preForeclosure', 'foreclosureUrgency', 'tenure', 'sourceListMotivation',
])
export const FIT_KEYS: readonly string[] = Object.keys(FIT_LABELS)
export const GENERIC_FIT_REASON = "Fits the buyer's criteria"

// A drawback is named only when it carried a real share of the score.
const MIN_HURT_SHARE = 10

const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1)

// The nightly reason: up to 3 fit features that raised the match, strongest
// first, then up to 2 that lowered it ("Right neighborhood, bedroom count;
// weaker on price").
export function fitReason(mf: Pick<MatchFitResult, 'contributions' | 'helped' | 'hurt' | 'priceFromEstimate'>): string {
  const nameable = (k: string) => Object.hasOwn(FIT_LABELS, k) && !(k === 'price' && mf.priceFromEstimate)
  const strengths = (mf.helped ?? []).filter(nameable).slice(0, 3).map(k => FIT_LABELS[k])
  const drawbacks = (mf.hurt ?? [])
    .filter(k => nameable(k) && (mf.contributions[k] ?? 0) >= MIN_HURT_SHARE)
    .slice(0, 2)
    .map(k => WEAK_LABELS[k])
  const weaker = drawbacks.length ? `weaker on ${drawbacks.join(' and ')}` : ''
  if (strengths.length && weaker) return `${capitalize(strengths.join(', '))}; ${weaker}`
  if (strengths.length) return capitalize(strengths.join(', '))
  if (weaker) return capitalize(weaker)
  return GENERIC_FIT_REASON
}

const SELLER_CIRCUMSTANCES = new RegExp(
  [
    'foreclos', 'lis pendens', 'auction', 'distress', 'equity', 'vacan', 'absentee', 'probate', '(?<!real )estate',
    'divorc', 'tax lien', 'delinquen', 'motivated', 'tenure', 'default', 'underwater', 'behind on', 'inherit',
    '\\bheirs?\\b', 'deceas', 'bankrupt', 'short sale', '\\breo\\b', 'bank[- ]owned', 'free and clear',
    'out of state', 'hardship', '\\bseniors?\\b', 'passed away', 'widow', 'eviction', 'judgment',
  ].join('|'),
  'i',
)
const MONEY = /\$\s?\d|\b\d+(\.\d+)?\s?(k|m|mm|million)\b/i
const SCORER_KEY = /^[a-z][A-Za-z]*$/

// A reason already stored on a Match row, made safe to show. Older nightly rows
// hold raw scorer keys ("preForeclosure + neighborhood + beds") with no
// direction: they read as "Matched on neighborhood, bedrooms", without
// motivation or unknown keys (and for a homeowner without price, which came
// from our estimate, or listing date, which doesn't apply). Legacy-engine rows
// hold model text: text about a seller's circumstances becomes the generic
// line, and for a homeowner so does any dollar figure.
export function plainFitReason(stored: string | null | undefined, opts: { homeowner?: boolean } = {}): string {
  const reason = (stored ?? '').trim()
  if (!reason) return GENERIC_FIT_REASON
  const parts = reason.split(/\s*\+\s*/)
  if (parts.every(p => SCORER_KEY.test(p))) {
    const named = parts
      .filter(p => Object.hasOwn(NEUTRAL_LABELS, p))
      .filter(p => !(opts.homeowner && (p === 'price' || p === 'recency')))
      .map(p => NEUTRAL_LABELS[p])
    return named.length ? `Matched on ${named.join(', ')}` : GENERIC_FIT_REASON
  }
  if (SELLER_CIRCUMSTANCES.test(reason)) return GENERIC_FIT_REASON
  if (opts.homeowner && MONEY.test(reason)) return GENERIC_FIT_REASON
  return reason
}

// A homeowner is never named: the address, else "Homeowner in <neighborhood>".
export function homeownerTitle(address: string | null | undefined, neighborhood: string | null | undefined): string {
  return address?.trim() || (neighborhood?.trim() ? `Homeowner in ${neighborhood.trim()}` : 'Homeowner')
}

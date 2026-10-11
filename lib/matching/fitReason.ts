// Brief 41 (H7): the plain-English "why it fits" line for a match.
//
// It names only fit features (place, price, size, type, building). It never
// names the seller-side motivation signals the scorer also weighs (distress,
// equity, vacancy, absentee owner, tenure, lead lists), or the buyer-strategy
// feature (it partly scores distress): those must never reach a buyer, a
// report or an outreach draft. Nor, since Brief 41.1, how few alternatives the
// buyer has (sales pressure) or how fresh the listing is. A strength is only a
// real match of what the buyer asked for; a drawback is named as one; and price
// is never named for a homeowner (their price is never shown: our estimate, or
// an expired listing's last asking price).
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
}
// The scorer's seller-motivation features: never named.
export const MOTIVATION_KEYS: ReadonlySet<string> = new Set([
  'highEquity', 'freeAndClear', 'goldenHandcuff', 'absenteeOwner', 'vacancy',
  'preForeclosure', 'foreclosureUrgency', 'tenure', 'sourceListMotivation',
])
// Never named: the motivation signals; the buyer-strategy feature (for a cash
// buyer it scores distress and equity); and (Brief 41.1) how few alternatives
// the buyer has, a sales-pressure line that must never reach a buyer, and the
// listing's age.
export const NEVER_NAMED: ReadonlySet<string> = new Set([
  ...MOTIVATION_KEYS, 'buyerArchetypeSituation', 'substitutionScarcity', 'recency',
])
export const FIT_KEYS: readonly string[] = Object.keys(FIT_LABELS)
export const GENERIC_FIT_REASON = "Fits the buyer's criteria"

// A strength is a real match of what the buyer asked for: those score 0.9-1.0.
// "No preference" defaults (0.7-0.8) and partial fits (an adjacent
// neighborhood 0.6) are not strengths. Price is a strength only inside the
// budget (score 1): 1.5% over still scores 0.9 (Brief 41.1).
const STRONG_SCORE = 0.9
const strongAt = (k: string) => (k === 'price' ? 1 : STRONG_SCORE)
// A drawback (score under 0.5) is named only when it carried a real share.
const MIN_HURT_SHARE = 10

const capitalize = (s: string) => s[0].toUpperCase() + s.slice(1)
const uncapitalize = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

// "Right neighborhood, bedroom count; weaker on price"
function composeReason(strengths: string[], drawbacks: string[]): string {
  const weaker = drawbacks.length ? `weaker on ${drawbacks.join(' and ')}` : ''
  if (strengths.length && weaker) return `${capitalize(strengths.join(', '))}; ${weaker}`
  if (strengths.length) return capitalize(strengths.join(', '))
  if (weaker) return capitalize(weaker)
  return GENERIC_FIT_REASON
}

// The nightly reason: up to 3 strengths, then up to 2 drawbacks, each by its
// share of the score ("Right neighborhood, bedroom count; weaker on price").
export function fitReason(mf: Pick<MatchFitResult, 'contributions' | 'scores' | 'homeownerSeller'>): string {
  const scores = mf.scores ?? {}
  const share = (k: string) => mf.contributions[k] ?? 0
  const ranked = Object.keys(scores)
    .filter(k => Object.hasOwn(FIT_LABELS, k) && !(k === 'price' && mf.homeownerSeller))
    .sort((a, b) => share(b) - share(a))
  const strengths = ranked.filter(k => scores[k] >= strongAt(k)).slice(0, 3).map(k => FIT_LABELS[k])
  const drawbacks = ranked.filter(k => scores[k] < 0.5 && share(k) >= MIN_HURT_SHARE).slice(0, 2).map(k => WEAK_LABELS[k])
  return composeReason(strengths, drawbacks)
}

// Wording that nightly rows stored before Brief 41.1 for features never named
// now: dropped when such a row is shown.
const RETIRED_STRENGTHS = ['few alternatives for this buyer', 'fresh listing']
const RETIRED_DRAWBACKS = ['uniqueness', 'listing age']
const RETIRED_NEUTRAL = ['scarcity of alternatives', 'listing date']
const RETIRED_WORDS = new Set([...RETIRED_STRENGTHS, ...RETIRED_DRAWBACKS, ...RETIRED_NEUTRAL])
const STRENGTH_WORDS = new Set([...Object.values(FIT_LABELS), ...RETIRED_STRENGTHS])
const DRAWBACK_WORDS = new Set([...Object.values(WEAK_LABELS), ...RETIRED_DRAWBACKS])
const NEUTRAL_WORDS = new Set([...Object.values(NEUTRAL_LABELS), ...RETIRED_NEUTRAL])
const PRICE_WORDS = new Set([FIT_LABELS.price, WEAK_LABELS.price, NEUTRAL_LABELS.price])

// A stored reason in our own wording (fitReason's, or the neutral "Matched on
// …" below) rebuilt without what's never shown now; null when it isn't our
// wording.
function ourWording(reason: string, homeowner: boolean): string | null {
  if (reason === GENERIC_FIT_REASON) return reason
  const shown = (w: string) => !RETIRED_WORDS.has(w) && !(homeowner && PRICE_WORDS.has(w))
  const neutral = /^Matched on (.+)$/.exec(reason)
  if (neutral) {
    const words = neutral[1].split(', ')
    if (!words.every(w => NEUTRAL_WORDS.has(w))) return null
    const kept = words.filter(shown)
    return kept.length ? `Matched on ${kept.join(', ')}` : GENERIC_FIT_REASON
  }
  const pieces = reason.split('; ')
  if (pieces.length > 2) return null
  const onlyWeaker = pieces.length === 1 && reason.startsWith('Weaker on ')
  const strengths = onlyWeaker ? [] : uncapitalize(pieces[0]).split(', ')
  const weaker = onlyWeaker ? uncapitalize(reason) : pieces[1]
  if (!strengths.every(w => STRENGTH_WORDS.has(w))) return null
  let drawbacks: string[] = []
  if (weaker !== undefined) {
    const m = /^weaker on (.+)$/.exec(weaker)
    if (!m) return null
    drawbacks = m[1].split(' and ')
    if (!drawbacks.every(w => DRAWBACK_WORDS.has(w))) return null
  }
  return composeReason(strengths.filter(shown), drawbacks.filter(shown))
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
// A dollar figure, with or without "$": "$1.84M", "1.84M", "1,840,000", "1840000".
const MONEY = /\$\s?\d|\b\d{1,3}(?:,\d{3})+\b|\b\d{5,}\b|\b\d+(?:\.\d+)?\s?(?:k|m|mm|million|thousand)\b/i
// A home value (our estimate is internal only).
const VALUE_WORD = /\b(?:estimat\w*|valu(?:e|ed|es|ation|ations)|apprais\w*|avm|zestimate|worth)\b/i
const SCORER_KEY = /^[a-z][A-Za-z]*$/
const SCORER_KEY_IN_TEXT = /\b[a-z]+[A-Z][A-Za-z]*\b/
const SCARCITY_TEXT = /\bfew (?:other )?alternatives\b|\balternatives for this buyer\b|\bscarcity\b/i

// A reason already stored on a Match row, made safe to show. Older nightly rows
// hold raw scorer keys ("preForeclosure + neighborhood + beds") with no
// direction: they read as "Matched on neighborhood, bedrooms", without
// never-named or unknown keys (and for a homeowner without price, which came
// from our estimate). Nightly rows in our wording are shown without what's never
// named now ("few alternatives for this buyer", listing age) and, for a
// homeowner, without price. A homeowner row shows nothing else: any other text
// (an older engine's, which could carry a name or our estimate) becomes the
// generic line. Other rows' older text does too when it names a seller's
// circumstances, a scorer key, the buyer's lack of alternatives or a home value.
export function plainFitReason(stored: string | null | undefined, opts: { homeowner?: boolean } = {}): string {
  const reason = (stored ?? '').trim()
  if (!reason) return GENERIC_FIT_REASON
  const homeowner = !!opts.homeowner
  const parts = reason.split(/\s*\+\s*/)
  if (parts.every(p => SCORER_KEY.test(p))) {
    const named = parts
      .filter(p => Object.hasOwn(NEUTRAL_LABELS, p))
      .filter(p => !(homeowner && p === 'price'))
      .map(p => NEUTRAL_LABELS[p])
    return named.length ? `Matched on ${named.join(', ')}` : GENERIC_FIT_REASON
  }
  if (homeowner && MONEY.test(reason)) return GENERIC_FIT_REASON
  const ours = ourWording(reason, homeowner)
  if (ours !== null) return ours
  if (homeowner) return GENERIC_FIT_REASON
  if (SELLER_CIRCUMSTANCES.test(reason) || SCORER_KEY_IN_TEXT.test(reason) || SCARCITY_TEXT.test(reason)) return GENERIC_FIT_REASON
  if (VALUE_WORD.test(reason) && MONEY.test(reason)) return GENERIC_FIT_REASON
  return reason
}

// A homeowner is never named: the address, else "Homeowner in <neighborhood>".
export function homeownerTitle(address: string | null | undefined, neighborhood: string | null | undefined): string {
  return address?.trim() || (neighborhood?.trim() ? `Homeowner in ${neighborhood.trim()}` : 'Homeowner')
}

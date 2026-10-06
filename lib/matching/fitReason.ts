// Brief 41 (H7): the plain-English "why it fits" line for a match.
//
// It names only fit features (place, price, size, type, building). It never
// names the seller-side motivation signals the scorer also weighs (distress,
// equity, vacancy, absentee owner, tenure, lead lists): those must never reach
// a buyer, a report or an outreach draft.
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
const MOTIVATION_KEYS = new Set([
  'highEquity', 'freeAndClear', 'goldenHandcuff', 'absenteeOwner', 'vacancy',
  'preForeclosure', 'foreclosureUrgency', 'tenure', 'sourceListMotivation',
])
export const GENERIC_FIT_REASON = "Fits the buyer's criteria"

function fromKeys(keys: string[]): string {
  const labels = keys.filter(k => FIT_LABELS[k]).map(k => FIT_LABELS[k])
  if (labels.length === 0) return GENERIC_FIT_REASON
  const line = labels.join(', ')
  return line[0].toUpperCase() + line.slice(1)
}

// The nightly reason: the top 3 fit contributions, strongest first.
export function fitReason(contributions: Record<string, number>): string {
  return fromKeys(
    Object.entries(contributions)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k)
      .filter(k => !MOTIVATION_KEYS.has(k))
      .slice(0, 3),
  )
}

const SELLER_CIRCUMSTANCES =
  /foreclos|lis pendens|auction|distress|equity|vacan|absentee|probate|(?<!real )estate|divorc|tax lien|delinquen|motivated|tenure|default|underwater|behind on/i
const MONEY = /\$\s?\d|\b\d+(\.\d+)?\s?(k|m|mm|million)\b/i

// A reason already stored on a Match row, made safe to show. Older nightly rows
// hold raw scorer keys ("preForeclosure + neighborhood + beds"): keys become
// words and motivation keys are dropped. Legacy-engine rows hold model text:
// text about a seller's circumstances becomes the generic line, and for a
// homeowner (whose only "price" was our estimate) so does any dollar figure.
export function plainFitReason(stored: string | null | undefined, opts: { homeowner?: boolean } = {}): string {
  const reason = (stored ?? '').trim()
  if (!reason) return GENERIC_FIT_REASON
  const parts = reason.split(/\s*\+\s*/)
  if (parts.every(p => p in FIT_LABELS || MOTIVATION_KEYS.has(p))) return fromKeys(parts.filter(p => !MOTIVATION_KEYS.has(p)))
  if (SELLER_CIRCUMSTANCES.test(reason)) return GENERIC_FIT_REASON
  if (opts.homeowner && MONEY.test(reason)) return GENERIC_FIT_REASON
  return reason
}

// A homeowner is never named: the address, else "Homeowner in <neighborhood>".
export function homeownerTitle(address: string | null | undefined, neighborhood: string | null | undefined): string {
  return address?.trim() || (neighborhood?.trim() ? `Homeowner in ${neighborhood.trim()}` : 'Homeowner')
}

// Brief 43 PR 12 (Q27, T-05, DRIFT_SCRIPT #12): our estimate in chat, for Ryan
// only. D9 (Brief 42 default D9, restated in Brief 46 §4.2): Drift may give our
// internal estimate in chat, labeled internal, with its range and date. Our
// values stay out of anything a buyer or homeowner could see [Ryan, 2026-10-17]:
// the estimate never goes on a seller card the page shows or stores, and PR 3's
// draft check keeps it out of drafts (lib/chat/guards/draftPrivacy.ts).
//
// The one chat file that reads DealFlow's own published values (Brief 49's pin
// test, lib/valuations/__tests__/readers.unit.test.ts, allows this file only).
// find_seller's match and get_seller_matches' seller carry `internalEstimate`
// (CONTRACT.md "PR 12"): the seller's newest published valuation, the one the CRM
// card shows (the run published last, then the newer row, as matching reads it).
// None, so null ("There's no value on file for that home."), when:
//   - the seller has no valuation in a published run;
//   - the newest one has no value (a home the model can't value: 5+ units, a
//     condo without a unit, not found): an older month's value is never used;
//   - its run was published more than 100 days ago (Brief 49's age rule, the
//     same MAX_VALUE_AGE_DAYS / recentEnough matching uses; Ryan's yes, 2026-10-19).
import { prisma } from '@/lib/prisma'
import { recentEnough } from '@/lib/matching/ourEstimates'

export type InternalEstimate = {
  value: number
  low: number                   // the range is sized to hold the sale price about 2 times in 3
  high: number
  asOf: string                  // "2026-10-01"
  runId: string
}

// What find_seller and get_seller_matches add to the seller (CONTRACT.md "PR 12").
// Only in the tool output (the guard and PR 3's draft check read it) and, as
// estimateForModel, in what Drift reads; never on a card the page gets.
export type SellerPriceFacts = {
  internalEstimate: InternalEstimate | null
  priorListingStatus: string | null   // EXPIRED | WITHDRAWN | ACTIVE | SOLD | NEVER_LISTED
  priorListingPrice: number | null    // that listing's last asking price (public), not our value
}

export type EstimateRow = {
  runId: string
  value: number | null
  low: number | null
  high: number | null
  asOf: Date
  createdAt: Date
  run: { publishedAt: Date | null }
}

const usable = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v > 0
const publishedTime = (r: EstimateRow) => r.run.publishedAt?.getTime() ?? -Infinity
const newer = (a: EstimateRow, b: EstimateRow) =>
  publishedTime(a) > publishedTime(b) || (publishedTime(a) === publishedTime(b) && a.createdAt.getTime() > b.createdAt.getTime())

// Pure: the newest of one seller's published valuations, if it is current and has a value and range.
export function pickInternalEstimate(rows: EstimateRow[], now: Date): InternalEstimate | null {
  let newest: EstimateRow | null = null
  for (const r of rows) if (!newest || newer(r, newest)) newest = r
  if (!newest || !recentEnough(newest.run.publishedAt, now)) return null
  const { value, low, high } = newest
  if (!usable(value) || !usable(low) || !usable(high) || low > value || value > high) return null
  return { value, low, high, asOf: newest.asOf.toISOString().slice(0, 10), runId: newest.runId }
}

// One seller's valuations in published runs (the import keeps about a dozen runs).
export async function loadInternalEstimate(organizationId: string, contactId: string, now: Date = new Date()): Promise<InternalEstimate | null> {
  const rows = await prisma.propertyValuation.findMany({
    where: { organizationId, contactId, run: { published: true } },
    select: { runId: true, value: true, low: true, high: true, asOf: true, createdAt: true, run: { select: { publishedAt: true } } },
  })
  return pickInternalEstimate(rows, now)
}

// ── How Drift says it ───────────────────────────────────────────────────────

// "$1.83M", "$845K": three figures at most, as Ryan's wording for #12 has them.
export function estimateMoney(n: number): string {
  if (n >= 999_500) return `$${Number((n / 1e6).toFixed(2))}M`
  return n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "Oct 1", with no year: the guard's dated_dollar_amount check reads "$2.14M as of
// October 2026" as a made-up sale (drift-1) [engineering precaution].
export function estimateDay(asOf: string): string {
  const d = new Date(`${asOf}T00:00:00Z`)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}

// Ryan's wording for DRIFT_SCRIPT #12 after Brief 43.
export function internalEstimateLine(e: InternalEstimate): string {
  return `Our internal estimate is ${estimateMoney(e.value)}, likely ${estimateMoney(e.low)}–${estimateMoney(e.high)}, as of ${estimateDay(e.asOf)}. That's for you only.`
}

export const NO_VALUE_LINE = "There's no value on file for that home."

// What Drift reads: the figures, the date as "Oct 1" and the line to say; no run id.
export function estimateForModel(e: InternalEstimate | null) {
  return e ? { value: e.value, low: e.low, high: e.high, asOf: estimateDay(e.asOf), say: internalEstimateLine(e) } : null
}

// Drift's view of a seller from find_seller or get_seller_matches.
export function sellerFactsForModel<T extends SellerPriceFacts>(seller: T): Omit<T, 'internalEstimate'> & { internalEstimate: ReturnType<typeof estimateForModel> } {
  return { ...seller, internalEstimate: estimateForModel(seller.internalEstimate) }
}

// The seller as a card the page shows or stores: without our estimate or the
// prior-listing fields (D9: chat text only [Brief 42 default; Ryan, 2026-10-17]).
const PRICE_FACT_KEYS = ['internalEstimate', 'priorListingStatus', 'priorListingPrice'] as const satisfies ReadonlyArray<keyof SellerPriceFacts>

export function withoutPriceFacts<T extends object>(seller: T): Omit<T, keyof SellerPriceFacts> {
  const card = { ...seller } as Record<string, unknown>
  for (const k of PRICE_FACT_KEYS) delete card[k]
  return card as Omit<T, keyof SellerPriceFacts>
}

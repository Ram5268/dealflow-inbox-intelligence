// Brief 2.5, Step 4 — fractional price overlap.
//
// Replaces binary in-range price matching with a 0–1 score reflecting how
// brokers actually think: a $4,050 rent IS a partial match for a $4,000 cap.
// Pure arithmetic on numbers, so the same helper serves sale prices and monthly
// rents alike.
//
// Tolerance is a fraction of the *max* bound (or the min, when there's no max):
// a listing is a full match (1) inside [min, max], degrades linearly to 0 as it
// moves `tolerance × bound` past the nearest edge, and is 0 beyond that.
export function priceOverlapScore(
  listingPrice: number | null,
  partyMin: number | null,
  partyMax: number | null,
  toleranceFraction = 0.05,
): number {
  if (listingPrice == null || (partyMin == null && partyMax == null)) return 0
  const lo = partyMin ?? 0
  const hi = partyMax ?? Number.POSITIVE_INFINITY
  if (listingPrice >= lo && listingPrice <= hi) return 1
  const distance = listingPrice < lo ? lo - listingPrice : listingPrice - hi
  const bound = (Number.isFinite(hi) ? hi : lo) * toleranceFraction
  if (bound === 0) return 0
  const score = 1 - distance / bound
  return score > 0 ? score : 0
}

// Brief 3.0, Step 4 — bedroom-match component of the matcher score.
//
// Extracted from lib/matchmaking.ts (pure, like priceOverlap.ts) so it can be
// unit-tested directly — the matcher module imports prisma via the `@/` alias,
// which ts-node (how `npm test` runs) won't resolve.
//
// The old guard `if (!listingBeds || !isoBeds) return 5` treated a real studio
// (beds === 0) as "unknown", because 0 is falsy: a studio↔studio match scored 5
// (the unknown-credit) instead of full credit, and — worse — a studio LISTING
// scored 5 against ANY demand (a 2BR seeker looked like a studio seeker). The
// fix distinguishes null/undefined (truly unknown → neutral 5) from a real 0.
//
// Brief 30.2 — the ISO side can store beds as either a scalar (`isoBeds`) OR a
// range (`isoMinBeds`/`isoMaxBeds` — the common case for buyer ISOs where the
// extractor captured "2-3BR"). Listing side is always scalar, but it can be
// fractional: 2-4 unit sellers are scored on beds PER UNIT (5 beds in a duplex =
// 2.5). A scalar `isoBeds` wins and is an exact count. Either side fully unknown
// → neutral 5 (preserves the prior null-safety contract; do not tighten or
// partial-extraction rows regress). Trailing params are optional, so existing
// 2-arg scalar calls are unchanged.
//
// Brief 41, for a RANGE (scalar null — how the Brief 32 scorer always calls it):
//  - only ONE end set stays open on the other side — "2+ BR" (min only) is
//    [2, ∞) and "up to 3BR" (max only) is [0, 3]. It used to collapse to the one
//    number it had, so a "2+ BR" buyer scored a 4BR home 0.
//  - the ±1 band covers part-bedroom gaps: 1 bedroom outside → 10, rising toward
//    20 as the gap shrinks (a 2.5-per-unit duplex vs a 3BR+ buyer → 15; it used
//    to score 0 while a farther 2.0 scored 10); further out → 0.
// A scalar keeps its exact rule (±1 only at a gap of exactly 1), unchanged for
// the legacy matcher, which passes mapISO's range midpoint (2.5) as a scalar.
export function bedsScore(
  listingBeds: number | null | undefined,
  isoBeds: number | null | undefined,
  isoMinBeds?: number | null | undefined,
  isoMaxBeds?: number | null | undefined,
): number {
  if (listingBeds == null) return 5 // listing side genuinely unknown

  const rawLo = isoBeds ?? isoMinBeds
  const rawHi = isoBeds ?? isoMaxBeds
  if (rawLo == null && rawHi == null) return 5 // ISO side genuinely unknown

  const lo = rawLo ?? 0                        // "up to N" → no lower bound
  const hi = rawHi ?? Number.POSITIVE_INFINITY // "N+" → no upper bound

  if (listingBeds >= lo && listingBeds <= hi) return 20 // in range — includes studio↔studio (0 in [0,0])
  const gap = listingBeds < lo ? lo - listingBeds : listingBeds - hi
  if (isoBeds != null) return gap === 1 ? 10 : 0 // scalar: exact ±1, as before
  // Rounded so per-unit fractions (2.7 vs 1.7) don't miss the band by a float hair.
  const distance = Math.round(gap * 1000) / 1000
  if (distance <= 1) return Math.round(20 - 10 * distance) // ±1 from the range: 10 at a full bedroom, more when closer
  return 0                                                // mismatch (e.g. 2BR demand vs studio)
}

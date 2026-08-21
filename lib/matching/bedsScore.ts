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
// extractor captured "2-3BR"). Listing side is always scalar (a physical unit
// has an exact bedroom count). Effective ISO range: [isoBeds ?? isoMinBeds,
// isoBeds ?? isoMaxBeds]. "In range" → 20, "±1 from range" → 10, else 0. Either
// side fully unknown → neutral 5 (preserves the prior null-safety contract; do
// not tighten or partial-extraction rows regress). Trailing params are optional,
// so existing 2-arg scalar calls are unchanged.
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

  const lo = rawLo ?? rawHi ?? 0
  const hi = rawHi ?? rawLo ?? Number.POSITIVE_INFINITY

  if (listingBeds >= lo && listingBeds <= hi) return 20 // in range — includes studio↔studio (0 in [0,0])
  const distance = listingBeds < lo ? lo - listingBeds : listingBeds - hi
  if (distance === 1) return 10 // ±1 from the range
  return 0                      // mismatch (e.g. 2BR demand vs studio)
}

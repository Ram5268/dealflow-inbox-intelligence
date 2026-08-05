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
export function bedsScore(
  listingBeds: number | null | undefined,
  isoBeds: number | null | undefined,
): number {
  if (listingBeds == null || isoBeds == null) return 5 // one side genuinely unknown
  if (listingBeds === isoBeds) return 20                // exact — includes studio↔studio (0 === 0)
  if (Math.abs(listingBeds - isoBeds) === 1) return 10  // ±1 bedroom
  return 0                                              // mismatch (e.g. 2BR demand vs studio)
}

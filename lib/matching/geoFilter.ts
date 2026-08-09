// Brief 7.0 — geo pre-filter. Load-bearing for COST: it reduces the candidate
// pool to a handful of plausible pairs BEFORE any Sonnet tiering call, so a
// query never fans out to dozens of LLM calls.
//
// It is deliberately GENEROUS. Its job is to drop only clear non-matches
// (different borough; same borough but disjoint specific neighborhoods), never
// to make the fine-grained call — that's the LLM's job. When geo is missing on
// either side we INCLUDE rather than risk dropping real signal.
//
// Reuses the single-source-of-truth helpers in lib/domain/Neighborhood.ts:
//   fromRaw(str)          → canonical neighborhood name (or null)
//   getBorough(canonical) → borough (or null)
//   getAdjacent(canonical)→ adjacent canonical names
import { fromRaw, getBorough, getAdjacent, BOROUGHS } from '../domain/Neighborhood'

type Borough = (typeof BOROUGHS)[number]

const BOROUGH_SET = new Set<string>(BOROUGHS as readonly string[])

// A raw borough string ("Manhattan", "manhattan", "the Bronx") → canonical
// borough, or null. Kept lenient (strip a leading "the", title-case compare).
function normalizeBorough(raw: string | null | undefined): Borough | null {
  if (!raw) return null
  const cleaned = raw.trim().replace(/^the\s+/i, '')
  const title = cleaned
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
  return BOROUGH_SET.has(title) ? (title as Borough) : null
}

// fromRaw() each input; drop the ones that don't resolve. Returns canonical names.
function canonicalHoods(raws: readonly string[]): string[] {
  const out: string[] = []
  for (const r of raws) {
    const c = fromRaw(r)
    if (c && !out.includes(c)) out.push(c)
  }
  return out
}

// Effective borough for a record: prefer an explicit borough string; otherwise
// derive it from the first resolvable neighborhood. null when nothing resolves.
function effectiveBorough(explicit: string | null | undefined, hoods: readonly string[]): Borough | null {
  const fromExplicit = normalizeBorough(explicit)
  if (fromExplicit) return fromExplicit
  for (const c of canonicalHoods(hoods)) {
    const b = getBorough(c)
    if (b) return b
  }
  return null
}

// Two neighborhood sets "overlap" if any canonical appears in both, OR any
// canonical in one is adjacent to a canonical in the other. Adjacency is counted
// because the pre-filter must not split naturally-contiguous demand (e.g. a UES
// buyer against a Yorkville listing, or Chelsea against West Chelsea) — those are
// exactly the pairs the LLM should get to weigh.
function hoodsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const bSet = new Set(b)
  for (const x of a) {
    if (bSet.has(x)) return true
    for (const adj of getAdjacent(x)) if (bSet.has(adj)) return true
  }
  return false
}

export interface GeoRecord {
  borough:       string | null
  neighborhoods: readonly string[]   // may be empty (broad criteria) or single-element (a listing)
}

/**
 * True ⇒ the pair survives the pre-filter and is worth an LLM tiering call.
 *
 * Rules (from the brief):
 *  1. Both boroughs known AND different            → EXCLUDE.
 *  2. Either borough unknown                       → INCLUDE (don't drop on missing geo).
 *  3. Boroughs match, both sides have specific hoods → INCLUDE iff they overlap.
 *  4. Boroughs match, either side hood-less (broad) → INCLUDE.
 */
export function geoAllows(party: GeoRecord, listing: GeoRecord): boolean {
  const pB = effectiveBorough(party.borough, party.neighborhoods)
  const lB = effectiveBorough(listing.borough, listing.neighborhoods)

  // Rule 1 + 2.
  if (pB && lB && pB !== lB) return false
  if (!pB || !lB) return true

  // Boroughs match from here.
  const pH = canonicalHoods(party.neighborhoods)
  const lH = canonicalHoods(listing.neighborhoods)

  // Rule 4 — broad criteria on at least one side.
  if (pH.length === 0 || lH.length === 0) return true

  // Rule 3 — both specific: keep only if they overlap.
  return hoodsOverlap(pH, lH)
}

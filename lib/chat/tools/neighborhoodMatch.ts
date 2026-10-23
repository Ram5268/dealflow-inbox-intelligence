// Brief 43 PR 7 (Q13): an area means that area, for search_listings and
// search_parties [engineering precaution; the finding's expected answer, in line
// with RYAN_MD's "Pass the specific neighborhoods a phrase implies"].
//
// Both tools used to keep a row when either canonical name contained the other,
// so Williamsburg pulled in East Williamsburg, Harlem East Harlem and Flatbush
// East Flatbush. Now a row matches only when one of its neighborhood strings
// resolves (lib/domain/Neighborhood fromRaw) to exactly a wanted canonical name.
// Spellings of the same area still match ("Bed-Stuy", "Stuyvesant Heights"), and
// a whole area includes its parts (SUB_AREAS: Harlem includes Central Harlem).
// The areas next door come in only when Drift asks with nearby: true.
import { fromRaw, getAdjacent, NEIGHBORHOODS } from '@/lib/domain/Neighborhood'

// The parts of a named area that lib/domain/Neighborhood keeps as their own
// canonical names. Asking for the whole area includes them (asking for a part
// never includes the whole). Each pair was joined by the old substring rule;
// only the "East X" pairs were wrong (Q13), so these stay [engineering
// precaution: no shrink beyond what Q13 asked for].
export const SUB_AREAS: Readonly<Record<string, readonly string[]>> = {
  'Harlem': ['Central Harlem', 'South Harlem', 'West Harlem'],
  'Midtown': ['Midtown East', 'Midtown West', 'Midtown South'],
  'Chelsea': ['West Chelsea'],
  'Williamsburg': ['South Williamsburg'],
  // One area under two names (Greenwood lists "Greenwood Heights" as a spelling).
  'Greenwood': ['Greenwood Heights'],
  'Greenwood Heights': ['Greenwood'],
}

// Canonical name, or the trimmed lowercase text for an area the map doesn't know
// (keeps unknown areas matchable against the same text).
export function canonHood(n: string | null | undefined): string | null {
  if (!n || !n.trim()) return null
  return fromRaw(n) ?? n.trim().toLowerCase()
}

// The asked areas as canonical names with their parts, plus their adjacent
// areas when nearby.
export function wantedHoods(names: readonly string[] | undefined, nearby = false): string[] {
  const out: string[] = []
  for (const n of names ?? []) {
    const c = canonHood(n)
    if (!c) continue
    for (const h of [c, ...(SUB_AREAS[c] ?? []), ...(nearby ? getAdjacent(c) : [])]) if (!out.includes(h)) out.push(h)
  }
  return out
}

export function hoodsMatch(want: readonly string[], rowHoods: readonly (string | null | undefined)[]): boolean {
  if (want.length === 0) return true
  return rowHoods.some(h => {
    const c = canonHood(h)
    return c != null && want.includes(c)
  })
}

// Text for the database filter: every spelling of the wanted areas, lowercased.
// fromRaw only resolves a string to an area when the string contains one of
// that area's spellings, so a case-insensitive `contains` on any of these keeps
// every row hoodsMatch would keep (a superset; hoodsMatch then decides).
export function hoodSqlTerms(want: readonly string[]): string[] {
  const terms: string[] = []
  for (const c of want) {
    const meta = NEIGHBORHOODS[c]
    for (const t of meta ? [c, ...meta.variants] : [c]) {
      const lower = t.trim().toLowerCase()
      if (lower && !terms.includes(lower)) terms.push(lower)
    }
  }
  // A term containing a shorter term adds nothing to a `contains` filter.
  return terms.filter(t => !terms.some(o => o !== t && t.includes(o)))
}

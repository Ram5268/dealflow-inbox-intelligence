// Brief 43 PR 10 (Q17; M19) — reading a guard match in its clause.
//
// The structural guard (regexGuard.ts) used to flag every source name, owner
// verb and LLC-shaped phrase wherever it appeared. Two kinds of honest reply
// then became stock replies: a decline ("I can't check Zillow") and a "no
// record" answer ("I don't have a record of when it last sold", DRIFT_SCRIPT #8).
// These helpers find the clause a match sits in, so regexGuard.ts can tell a
// claim from a decline, an offer or a question, and toolBinding.ts can check the
// figures and names a deed claim carries against this turn's ACRIS block.
// [engineering precaution]
//
// Regex safety: every quantifier here is bounded or runs once over the text
// (no unbounded quantifier inside a lookaround); the clause breaks are found
// once per reply and looked up by binary search.

// A clause ends at a sentence end, ";", a new line, a dash, ": ", or a join
// that starts a new claim (", but", ", so", ", and", ", though", ", while",
// ", want me to…", " but ").
const CLAUSE_BREAK = /[.!?](?=\s|$)|[;\n]|,\s{1,4}(?:but|so|and|though|although|however|while|yet|want|shall|should|would)\b|\s{1,4}but\s|[—–]|\s-\s|:\s/g

export type Breaks = Array<[start: number, end: number]>

export function clauseBreaks(text: string): Breaks {
  const out: Breaks = []
  CLAUSE_BREAK.lastIndex = 0
  for (const m of text.matchAll(CLAUSE_BREAK)) out.push([m.index!, m.index! + m[0].length])
  return out
}

export interface Clause {
  start: number
  end: number
  /** Clause text before the match. */
  before: string
  /** Clause text after the match. */
  after: string
  /** True when the clause ends the sentence with a question mark. */
  question: boolean
}

// How far a clause is read on each side of a match. A clause longer than this
// is a run-on (or a pasted list); reading all of it for every match made a
// 20 KB reply with hundreds of matches slow.
const CLAUSE_WINDOW = 300

/**
 * The clause around text[start, end), read at most CLAUSE_WINDOW characters
 * either side. Breaks inside the match are ignored.
 */
export function clauseAround(text: string, start: number, end: number, breaks: Breaks = clauseBreaks(text)): Clause {
  // Last break that ends at or before the match.
  let lo = 0
  let hi = breaks.length - 1
  let prev = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (breaks[mid][1] <= start) { prev = mid; lo = mid + 1 } else hi = mid - 1
  }
  let next = prev + 1
  while (next < breaks.length && breaks[next][0] < end) next++
  const ce = next < breaks.length ? breaks[next][0] : text.length
  const cs = Math.max(prev >= 0 ? breaks[prev][1] : 0, start - CLAUSE_WINDOW)
  const ceRead = Math.min(ce, end + CLAUSE_WINDOW)
  return {
    start: cs,
    end: ceRead,
    before: text.slice(cs, start),
    after: text.slice(end, ceRead),
    question: text[ce] === '?',
  }
}

// Curly apostrophes to straight ones, one for one, so offsets stay the same.
export function straightApostrophes(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'")
}

// A dollar figure or a percentage.
export const FIGURE = /\$\s?\d|\b\d{1,3}(?:\.\d{1,2})?\s?%/

// A year a deed could carry.
const YEAR = /\b(?:19|20)\d{2}\b/g
export function yearsIn(text: string): string[] {
  return text.match(YEAR) ?? []
}

// "$1,200,000", "$1.2M", "$1.2 million", "$640K" as numbers. `rounded` is true
// for the short forms, which a reply may round.
const DOLLARS = /\$\s?(\d{1,3}(?:,\d{3})+|\d{1,12})(?:\.(\d{1,3}))?(?:\s?(M|K|million|thousand)\b)?/gi
export function dollarAmounts(text: string): Array<{ value: number; rounded: boolean }> {
  const out: Array<{ value: number; rounded: boolean }> = []
  DOLLARS.lastIndex = 0
  for (const m of text.matchAll(DOLLARS)) {
    const whole = Number(m[1].replace(/,/g, ''))
    const value = Number(`${whole}${m[2] ? `.${m[2]}` : ''}`)
    const unit = (m[3] ?? '').toLowerCase()
    const scale = unit === 'm' || unit === 'million' ? 1_000_000 : unit === 'k' || unit === 'thousand' ? 1_000 : 1
    out.push({ value: value * scale, rounded: scale > 1 })
  }
  return out
}

// Words a name never starts with: sentence openers, determiners, counts and
// pronouns ("Two LLC-owned sellers", "The LLC", "Yes, Example Holdings…").
export const NOT_A_NAME = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'its', 'it', "it's", 'their', 'his', 'her', 'our', 'your', 'my',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'both', 'each', 'every', 'any', 'all',
  'some', 'several', 'many', 'most', 'few', 'no', 'none', 'other', 'another', 'same', 'which', 'what', 'whose', 'who',
  'yes', 'so', 'and', 'but', 'or', 'if', 'is', 'are', 'was', 'were', 'then', 'in', 'on', 'at', 'after', 'before',
  'later', 'also', 'only', 'just', 'actually', 'recently', 'eventually', 'they', 'he', 'she', 'we', 'i', 'there',
  'ryan', 'drift',
])

// Company suffixes: not a name on their own.
const SUFFIX_WORDS = new Set(['llc', 'l', 'c', 'inc', 'corp', 'corporation', 'lp', 'p', 'trust', 'holdings', 'realty', 'group', 'partners', 'co'])

/**
 * The words of a name, lowercased, for an order-free check against a record
 * block ("Jordan Sample" against ACRIS's "SAMPLE, JORDAN"). Leaves out openers,
 * company suffixes and one-letter initials.
 */
export function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map(w => w.replace(/^'+|'+$/g, ''))
    .filter(w => w.length > 1 && !NOT_A_NAME.has(w) && !SUFFIX_WORDS.has(w))
}

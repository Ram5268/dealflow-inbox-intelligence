// Brief 5.1, Step 1 — regex-based structural hallucination detector.
//
// Fast, deterministic first pass over Drift's (Sonnet 4.6) final text reply.
// It catches the STRUCTURAL shape of the two hallucination classes the stress
// test surfaced — fabricated URLs, external data-source citations (ACRIS,
// StreetEasy, Zillow…), invented LLC/Corp ownership entities, and dated
// sale-history citations — none of which Drift has a tool to source. Any match
// means the response volunteered a fact not present in tool results.
//
// This runs BEFORE the LLM verifier (cheap gate first). A clean pass here does
// not mean grounded — the semantic verifier still runs; a match here does mean
// the response is rejected and retried regardless of what the verifier thinks.
//
// Brief 43 PR 2 (Q2) adds Drift's "never sent" check (compliance.ts) to the
// same scan: a reply claiming it sent, texted, called or booked something is
// flagged `action_claim` [Ryan, 2026-09-24: nothing contacts anyone].
//
// Brief 43 PR 10 (Q17; M19): the scan reads each source name, owner verb and
// company name in its clause (claimContext.ts) [engineering precaution]:
// - a source named in a decline, an offer, a pointer for Ryan or a question is
//   not a citation ("I can't check Zillow", "I can pull the ACRIS records", "You
//   could check Zillow", "Want me to check StreetEasy?"), unless the clause also
//   carries a figure or says what the source shows;
// - an owner or sale verb in a "no record" clause, an offer or a question is not
//   a claim ("I don't have a record of when it last sold", DRIFT_SCRIPT #8),
//   unless a name, a dollar figure or a year comes with it;
// - `corporate_entity` needs a named entity: "Two LLC-owned sellers", "an LLC"
//   and "The LLC" name none. Its match is the name itself, so tool binding can
//   trace it;
// - an owner claim's match carries the name it gives ("owner is Pat Example"),
//   so tool binding can check it against this turn's ACRIS block;
// - `external_url` also catches "www." and "site.com/path" links: Drift never
//   writes a link; links reach Ryan as buttons.
// Which of the remaining flags this turn's lookups support is toolBinding.ts's
// job.
import { scanActionClaims, type ActionClaimOptions } from './compliance'
import { clauseBreaks, clauseAround, straightApostrophes, FIGURE, NOT_A_NAME, type Breaks } from './claimContext'

export interface RegexFlag {
  pattern: string // named pattern that triggered (e.g. 'external_url')
  match: string // the exact matched substring from the response
}

interface NamedPattern {
  name: string
  regex: RegExp
}

// Each pattern is global so we can enumerate every match; names mirror the
// Brief 5.1 spec table. `i` where casing varies in real prose.
const PATTERNS: NamedPattern[] = [
  {
    // Drift never writes a URL. The live StreetEasy search and the listing cards
    // reach Ryan as buttons (Brief 43 PR 10), so any URL in the text is one Drift
    // wrote. Hard flag: no tool result or block clears it. Also "www." links
    // and "site.com/path" ones with no scheme (drift-2 p3); a bare "Realtor.com"
    // with no path is a name, not a link.
    name: 'external_url',
    regex: /\b(?:https?:\/\/|www\.)[^\s)\]}]+|\b[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9-]{1,63}){0,3}\.(?:com|net|org|io|nyc|gov|us)\/[^\s)\]}]*/gi,
  },
  {
    // Named external data sources Drift never queries.
    name: 'real_estate_source_citation',
    regex: /\b(ACRIS|PropertyShark|PLUTO|DOB|StreetEasy|Zillow|Trulia|Realtor\.com|MLS|RLS|REBNY|Redfin|CoreLogic|RealtyTrac|Naked Apartments|OneKey)\b/gi,
  },
  {
    // LLC / Inc / Corp entity names => ownership invention.
    name: 'corporate_entity',
    regex: /\b[A-Z][A-Za-z0-9\s&'-]{2,60}?\s+(LLC|L\.L\.C\.|Inc\.?|Corp\.?|Corporation|LP|L\.P\.|Trust|Holdings|Realty(?:\s+Group)?|Partners)\b/g,
  },
  {
    // "$X on YYYY-MM-DD" => fabricated sale-history citation.
    name: 'dated_dollar_amount',
    regex: /\$[\d,]+(?:\.\d+)?(?:\s*(?:M\b|K\b|million\b|thousand\b))?\s+(?:on|as of|in|from|dated)\s+(?:\d{4}|\w+\s+\d{4}|\d{4}-\d{2}-\d{2})/gi,
  },
  {
    // Ownership claims. Brief 43 PR 10: tool binding clears them only against
    // this turn's ACRIS block (D1 [Ryan, 2026-10-17]: deed owners may be named).
    // Also "bought by", "sold it to" and "<Name> bought it" (DRIFT_SCRIPT #8: an
    // invented buyer for a made-up sale).
    name: 'ownership_assertion',
    regex: /\b(owned by|owner is|purchased by|bought by|sold (?:it )?to|acquired by|transferred (?:from|to)|previous owner)\b/gi,
  },
  {
    name: 'ownership_assertion',
    regex: /\b[A-Z][A-Za-z'-]{1,30}(?: [A-Z][A-Za-z'-]{1,30}){0,3} (?:bought|purchased|acquired) (?:it|them|the [\w-]{1,20})\b/g,
  },
  {
    // Historical transaction claims.
    name: 'historical_sale_verb',
    regex: /\b(last sold|previous sale|sold in \d{4}|purchased in \d{4}|acquired in \d{4}|closed on \d{4})\b/gi,
  },
  {
    // Market statistics Drift has no source for. Two shapes:
    //   1. number-first: "10% higher", "8.5% year-over-year", "12% increase"
    //   2. appreciation-first: "appreciation of 8%", "appreciated 5%"
    // NOTE (Brief 5.1.1, Fix 1): bare direction tokens `up`/`down` were dropped
    // from shape 1. "25% down" / "20% down payment" is mortgage LTV terminology,
    // not a market claim, and was firing false positives on straightforward
    // mortgage-math questions. Genuine market declines carry a timeframe/token
    // we still catch ("down 10% YoY" matches on "10% YoY"; "5% lower" on lower).
    name: 'invented_stat',
    regex: /\b\d+(?:\.\d+)?%\s+(?:yoy|year[- ]over[- ]year|higher|lower|increase|decrease|appreciation)\b|\bappreciat(?:ion|ing|ed)\s+(?:of\s+)?\d+(?:\.\d+)?%/gi,
  },
]

/**
 * Scan a candidate response for structural hallucination signatures.
 * Returns one RegexFlag per matched substring (a pattern can fire multiple
 * times). Empty array = structurally clean.
 *
 * `opts.userMessage` (Brief 43 PR 2) lets the never-sent check read a bare
 * "Done" right after a send request ("send it") as a claim.
 */
export function scanForStructuralHallucinations(response: string, opts: ActionClaimOptions = {}): RegexFlag[] {
  if (!response) return []
  // Brief 43 PR 10: the clause checks read a copy with straight apostrophes
  // (same length, so match offsets line up); matches come from the reply as
  // written.
  const text = straightApostrophes(response)
  let breaks: Breaks | null = null
  const clauses = () => (breaks ??= clauseBreaks(text))
  const flags: RegexFlag[] = []
  for (const { name, regex } of PATTERNS) {
    // Fresh lastIndex per call — regex literals are module-level and stateful
    // with the /g flag, so reset before iterating.
    regex.lastIndex = 0
    for (const m of response.matchAll(regex)) {
      const start = m.index ?? 0
      const end = start + m[0].length
      if (name === 'real_estate_source_citation' && sourceNotCited(text, start, end, clauses())) continue
      if (name === 'corporate_entity') {
        const entity = namedEntity(response, start, end, m[1] ?? '')
        if (entity) flags.push({ pattern: name, match: entity })
        continue
      }
      if (name === 'ownership_assertion' || name === 'historical_sale_verb') {
        if (deedNotAsserted(text, start, end, clauses())) continue
        if (name === 'ownership_assertion') {
          flags.push({ pattern: name, match: response.slice(start, end + ownerNameAfter(text, end).length).trim() })
          continue
        }
      }
      flags.push({ pattern: name, match: m[0].trim() })
    }
  }
  flags.push(...scanActionClaims(response, opts))
  return flags
}

// ── Brief 43 PR 10 (Q17): claims, declines, offers and questions ────────────

// "I can't check …", "I don't have MLS access", "no access to …", "Zillow
// isn't something I can check".
const DECLINE: RegExp[] = [
  /\bI(?:\s{1,3}(?:(?:just|simply|currently)\s{1,3})?(?:can't|cannot|can\s{1,3}not|am\s{1,3}unable\s{1,3}to|am\s{1,3}not\s{1,3}able\s{1,3}to|have\s{1,3}no\s{1,3}way\s{1,3}to|don't\s{1,3}have\s{1,3}(?:a|any)\s{1,3}way\s{1,3}to)|'m\s{1,3}(?:unable|not\s{1,3}able)\s{1,3}to)\b/i,
  /\b(?:don't|do\s{1,3}not)\s{1,3}have\s{1,3}(?:[\w.-]{1,30}\s{1,3}){0,3}?(?:access|connection|feed|login|subscription|account)\b/i,
  /\bhave\s{1,3}no\s{1,3}(?:[\w.-]{1,30}\s{1,3}){0,3}?(?:access|connection|feed|way)\b/i,
  /\bno\s{1,3}(?:[\w.-]{1,30}\s{1,3}){0,2}?(?:access|connection|feed)\s{1,3}(?:to|into|for)\b/i,
  /\b(?:isn't|is\s{1,3}not|aren't|are\s{1,3}not)\s{1,3}(?:something|anything|a\s{1,3}source|sources?|one)\s{1,3}I\s{1,3}(?:can|have)\b/i,
  /\b(?:isn't|is\s{1,3}not|aren't|are\s{1,3}not)\s{1,3}(?:connected|hooked\s{1,3}up|linked|available\s{1,3}to\s{1,3}me)\b/i,
  /\boutside\s{1,3}what\s{1,3}I\s{1,3}can\b/i,
]
// An offer to look something up: "I can pull the ACRIS records", "Want me to
// check StreetEasy?". Not "I can see …" (that reports a result).
const OFFER = /\b(?:I(?:\s{1,3}(?:can|could|will)|'ll)|let\s{1,3}me|want\s{1,3}me\s{1,3}to|shall\s{1,3}I|should\s{1,3}I|would\s{1,3}you\s{1,3}like\s{1,3}me\s{1,3}to|happy\s{1,3}to)\s{1,3}(?:(?:also|then|quickly|now|still|just|go)\s{1,3})?(?:look|check|pull|search|run|fetch|get|bring|dig|try|query|open)\b/i
// Pointing Ryan to a source: "I'd point you toward StreetEasy's neighborhood
// guides", "You could check Zillow".
const REFERRAL = /\b(?:point(?:ing)?\s{1,3}you\s{1,3}(?:to|toward|towards)|I(?:'d|\s{1,3}would)?\s{1,3}(?:suggest|recommend)|you\s{1,3}(?:can|could|might|may|should)\s{1,3}(?:(?:also|still|always)\s{1,3})?(?:check|try|look|use|search|browse|pull)|worth\s{1,3}checking)\b/i
// The source says something, anywhere after it in the clause: "StreetEasy
// shows …", "ACRIS lists Pat …", "Zillow, which has it at …".
const SOURCE_SAYS = /\b(?:shows?|showed|showing|lists|listed|says|said|reports?|reported|indicates?|recorded|confirms?|notes|(?:has|had|puts|gives|estimates?|values?|prices?)\s{1,3}(?:it|them|the|a|an|this|that|two|three|\d))\b/i
// A claim earlier in the clause: "It shows as expired on MLS, which …".
const CLAIM_BEFORE = /\b(?:shows?|showed|showing|lists|listed|says|said|reported|recorded|expired|sold|asking|priced|has\s{1,3}it|had\s{1,3}it)\b/i
// The source cited as where a fact came from: "per ACRIS", "according to MLS".
const CITED_FROM = /\b(?:per|according\s{1,3}to|based\s{1,3}on|citing)\s{1,3}(?:the\s{1,3})?(?:latest\s{1,3}|live\s{1,3})?$/i

function firstIndex(res: RegExp[], s: string): number {
  let at = -1
  for (const re of res) {
    const m = re.exec(s)
    if (m && (at < 0 || m.index < at)) at = m.index
  }
  return at
}

/**
 * True when a source name is not cited as a source: it sits in a decline, an
 * offer, a pointer for Ryan or a question, the clause carries no figure, and
 * nothing says what the source shows. "I can't check Zillow or StreetEasy from
 * here" (drift-2 p3b) is a decline; "I can't check Zillow, but StreetEasy shows
 * it at $1.9M" still cites StreetEasy.
 */
function sourceNotCited(text: string, start: number, end: number, breaks: Breaks): boolean {
  const c = clauseAround(text, start, end, breaks)
  const clause = c.before + text.slice(start, end) + c.after
  if (FIGURE.test(clause) || CITED_FROM.test(c.before) || SOURCE_SAYS.test(c.after)) return false
  const hedgeAt = firstIndex([...DECLINE, OFFER, REFERRAL], clause)
  if (hedgeAt < 0) return c.question && !CLAIM_BEFORE.test(c.before)
  // "Zillow isn't something I can check" is fine; "It shows as expired on MLS,
  // which isn't something I can check" is a claim first.
  return hedgeAt < c.before.length || !CLAIM_BEFORE.test(c.before)
}

// What can make an owner or sale verb a non-claim, when it governs the verb:
// a "no record" phrase ("I don't have a record of …", "I'm not sure who …"),
// an offer ("I can look up when …") or a conditional ("whether it last sold").
// A hedge governs the verb only when a linking word ("when", "who", "whether",
// "of", "about") follows it, so "No surprise, it sold to a developer" and
// "Let me check the records, it was sold to a developer" are still claims.
const NO_RECORD = /\bno\s{1,3}(?:record|records|deed|deeds|sale|sales|data|information|info|filings?)\b|\b(?:don't|do\s{1,3}not|didn't|did\s{1,3}not)\s{1,3}(?:have|know|see)\b|\bhave\s{1,3}no\b|\b(?:can't|cannot|can\s{1,3}not|couldn't|could\s{1,3}not)\s{1,3}(?:find|see|tell|confirm|verify|say|check|look\s{1,3}up|pull)\b|\bnot\s{1,3}(?:sure|certain)\b|\bnothing\s{1,3}on\s{1,3}file\b|\bthere(?:'s|\s{1,3}is|\s{1,3}are|\s{1,3}was)\s{1,3}no\b|\bI(?:\s{1,3}(?:can|could|will)|'ll)\s{1,3}(?:tell|confirm|find|see)\b/gi
const LINKED = /\b(?:when|who|whom|whose|whether|if|what|how|which|of|about|on)\b/i
const CONDITIONAL = /\b(?:if|whether|unless)\s{1,3}(?:it|the|they|this|that|anyone|someone)\b/i
const OFFER_ALL = new RegExp(OFFER.source, 'gi')

function hedgeGoverns(before: string): boolean {
  if (CONDITIONAL.test(before)) return true
  let last = -1
  for (const re of [NO_RECORD, OFFER_ALL]) {
    re.lastIndex = 0
    for (const m of before.matchAll(re)) last = Math.max(last, (m.index ?? 0) + m[0].length)
  }
  return last >= 0 && LINKED.test(before.slice(last))
}

// "The owner is not on file", "the previous owner is unknown".
const NEGATED_OBJECT = /^\s{1,3}(?:not|unknown|unclear|unlisted|missing)\b/i
const YEAR_OR_FIGURE = /\$\s?\d|\b(?:19|20)\d{2}\b/

/**
 * True when an owner or sale verb asserts nothing: a "no record" phrase, an
 * offer or a conditional governs it, or it's in a question (or its object is
 * "not on file"), and no name, dollar figure or year comes with it.
 * DRIFT_SCRIPT #8: "I don't have a record of who bought it or when it last
 * sold" stays as written; "It sold to Pat Example" and "I don't have the deed,
 * but it last sold in 2019" are still claims.
 */
function deedNotAsserted(text: string, start: number, end: number, breaks: Breaks): boolean {
  const c = clauseAround(text, start, end, breaks)
  const hedged = hedgeGoverns(c.before) || c.question || NEGATED_OBJECT.test(c.after)
  if (!hedged) return false
  if (YEAR_OR_FIGURE.test(text.slice(start, end)) || YEAR_OR_FIGURE.test(c.after)) return false
  // The "<Name> bought it" form carries its name in the match.
  if (/^[A-Z]/.test(text.slice(start, end)) && !/^(?:owned|owner|purchased|bought|sold|acquired|transferred|previous)\b/i.test(text.slice(start, end))) {
    return !text.slice(start, end).split(' ').some(w => /^[A-Z]/.test(w) && !NOT_A_NAME.has(w.toLowerCase()))
  }
  return ownerNameAfter(text, end, { skipNegation: true }).trim() === ''
}

// The name an owner verb gives: "owner is Pat Example", "sold to the Example
// Family Trust", "previous owner: SAMPLE". Up to 8 capitalized words, after
// "is", "was", "listed as", "the" and the like; it stops at a comma or a
// lowercase word, so "previous owner of 88 Example Ave" gives none.
// A dot stays inside a word only before a letter or digit ("L.L.C"), so a
// sentence end stops the name.
const OWNER_NAME = /^(?:\s{0,2}:)?(?:\s{1,3}(?:is|was|were|are|listed\s{1,3}as|recorded\s{1,3}as|shown\s{1,3}as|named|being|a|an|the|still|now|currently|to|by))*\s{1,3}([A-Z0-9](?:[\w'&-]|\.(?=\w)){0,40}(?:\s{1,3}(?:(?:&|and)\s{1,3})?[A-Z0-9](?:[\w'&-]|\.(?=\w)){0,40}){0,7})/
function ownerNameAfter(text: string, end: number, opts: { skipNegation?: boolean } = {}): string {
  let after = text.slice(end, end + 400)
  let skipped = 0
  if (opts.skipNegation) {
    const neg = after.match(NEGATED_OBJECT)
    if (neg) { skipped = neg[0].length; after = after.slice(skipped) }
  }
  const m = after.match(OWNER_NAME)
  if (!m) return ''
  const words = m[1].split(/\s+/)
  // "is The" or "Ryan" alone is no name.
  if (!words.some(w => /[A-Za-z0-9]/.test(w) && !NOT_A_NAME.has(w.toLowerCase().replace(/[^a-z0-9']/g, '')))) return ''
  return text.slice(end, end + skipped + m[0].length)
}

/**
 * The company a `corporate_entity` match names, or null when it names none.
 * The regex's match can start several words early ("The owner is Example
 * Holdings"); the entity is the run of capitalized words before the suffix,
 * minus openers ("Two LLC-owned sellers", "The LLC" and "an LLC" name none),
 * plus a legal suffix right after ("Example Street Holdings LLC"). Not "LP" as
 * a noun ("the Quarterly LP Update report").
 */
function namedEntity(text: string, start: number, end: number, suffix: string): string | null {
  const m = text.slice(start, end)
  if (/^L\.?P\.?$/.test(suffix) && /^\s{1,3}(?:update|updates|report|reports|letter|letters|investors?|meeting|capital)\b/i.test(text.slice(end, end + 30))) return null
  const namePart = m.slice(0, m.length - suffix.length)
  const words = [...namePart.matchAll(/\S+/g)]
  let i = words.length
  while (i > 0 && /^[A-Z0-9&]/.test(words[i - 1][0])) i--
  while (i < words.length && NOT_A_NAME.has(words[i][0].toLowerCase().replace(/[^a-z']/g, ''))) i++
  if (i >= words.length) return null
  const tail = text.slice(end, end + 12).match(/^,?\s{1,2}(?:LLC|L\.L\.C\.?|Inc\.?|Corp\.?|LP|L\.P\.?)(?!\w)/)
  return text.slice(start + (words[i].index ?? 0), end + (tail ? tail[0].length : 0)).trim()
}

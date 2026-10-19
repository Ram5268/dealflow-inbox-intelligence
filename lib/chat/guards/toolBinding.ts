// Brief 11.0, Fix #1 — tool-output binding (guard scope: entity claims only).
//
// The regex structural guard (regexGuard.ts) treats every LLC/Corp-shaped name
// as "ownership invention". That threat model is right for a name Drift made up
// — but WRONG for a name that came straight out of a tool result. Ryan's Mojo
// CRM is full of real seller leads held under an LLC ("Tompkins Mazal Bh 101
// LLC"), and when search_parties returns one and Drift repeats it, the guard
// fired and returned the canned fallback despite the data being real. That was
// the "yes let's pull those" false positive from dogfooding.
//
// This implements the brief's Option 2 (tool-output binding): a specific-entity
// claim that traces to THIS turn's tool output — or the prior turn's DEAL CARDS
// — is grounded, not a hallucination, and its structural flag is dropped. Every
// other structural pattern (fabricated URLs, external-source citations like
// ACRIS, ownership/history verbs, invented stats, dated sale amounts) is
// un-sourceable by construction — none of those strings can appear in a tool
// result — so those flags keep firing regardless.
//
// SAFETY PROPERTY (preserved): an entity claim (name/LLC/party id) that CANNOT
// be traced to tool output OR the prior turn's DEAL CARDS still fires the guard.
// The threat model — a fabricated prospect reaching Ryan — is intact.
//
// Brief 43 PR 10 (Q17; M19): what this turn fetched decides what's grounded
// [engineering precaution; D1 [Ryan, 2026-10-17]: deed owners may be named].
// - The route's grounding is this turn's tool results and side-lookup blocks
//   (plus the prior turn's cards, for entity names). RYAN_MD is out: it names
//   ACRIS, DOB and StreetEasy, so every invented "per ACRIS" looked grounded.
// - A source name is grounded by its own block this turn (ACRIS, DOB, live
//   StreetEasy) or by this turn's tool results. Not by the prior turn's cards
//   (stored email bodies Drift doesn't see this turn), and not by a lookup's
//   "didn't answer in time" note.
// - Deed facts bind to this turn's ACRIS block: an owner claim's name, and the
//   dollar figures and years in a sale claim's clause, must all be in it.
// - external_url stays a hard flag: links reach Ryan as buttons, so any URL in
//   the text is one Drift wrote.
import type { RegexFlag } from './regexGuard'
import type { ToolResultForVerify } from './llmVerifier'
import { clauseAround, clauseBreaks, dollarAmounts, yearsIn, nameTokens, straightApostrophes, type Breaks } from './claimContext'

// Structural patterns whose matches can LEGITIMATELY appear in the grounding
// corpus (this turn's tool output, the prior turn's DEAL CARDS, or — Brief 26.0
// — the side-channel context block). A match that traces to the corpus is
// grounded and its flag is dropped; a match that does NOT trace still fires.
// All other patterns stay hard fails.
//
// - corporate_entity (Brief 11.0): party/owner names, incl. an LLC-held Mojo
//   seller lead, are real when they came from search_parties or a card.
// - real_estate_source_citation (Brief 26.0): "un-sourceable by construction"
//   WAS true when Drift had no way to read ACRIS/DOB/etc. Now the system fetches
//   those and injects them as side-channel context. When "DOB"/"ACRIS" actually
//   appears in the corpus, the system genuinely read that source this turn, so
//   Drift naming it is grounded — NOT a fabricated citation. A source name with
//   no corpus backing (e.g. a fabricated "per StreetEasy" when no StreetEasy
//   block was fetched) still fires. external_url stays hard-fail: Drift has no
//   URL-returning tool, so any URL is fabricated regardless of the corpus.
//   Brief 43 PR 10 narrows "in the corpus" to the source's own block this turn
//   or this turn's tool results (sourceIsGrounded): the name turning up in
//   RYAN_MD, a stored email body or a timeout note fetched nothing.
// - action_claim (Brief 43 PR 2) is never bindable either: nothing in DealFlow
//   sends, texts, calls or books, so no tool result can make "Sent" true
//   [Ryan, 2026-09-24].
export const TOOL_BINDABLE_PATTERNS = new Set<string>(['corporate_entity', 'real_estate_source_citation'])

// Brief 43 PR 10: deed facts. Grounded only by this turn's ACRIS block, and only
// when the reply's names and figures match it (bindDeedFlag).
export const DEED_FACT_PATTERNS = new Set<string>(['ownership_assertion', 'historical_sale_verb', 'dated_dollar_amount'])

// Normalize for a forgiving substring trace: lowercase, non-alphanumerics → a
// single space. So "Tompkins Mazal Bh 101 LLC" in the response matches
// "tompkins mazal bh 101 llc" wherever it sits inside the tool-output JSON,
// regardless of surrounding punctuation/quoting.
export function normalizeForTrace(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Flatten this turn's tool outputs (+ optionally the prior turn's DEAL CARDS +
 * the turn's side-channel context block) into one normalized string the trace
 * check greps against. Built once per turn — tool results don't change across
 * guard retries.
 *
 * Brief 26.0 — sideChannelText carries the dynamic system block Sonnet was given
 * (live ACRIS ownership, DOB permits, FRED mortgage rates, Mojo, calendar). That
 * data is real, grounded evidence — it just lives in the system prompt rather
 * than a tool result. Folding it into the corpus lets a corporate_entity /
 * owner-name claim that traces to it count as grounded, same as a tool-backed
 * one. This is a text-additive change: the structured tool-result data model is
 * untouched; only the fuzzy-match corpus grows.
 */
export function buildGroundingCorpus(
  toolResults: ToolResultForVerify[],
  priorDealCards?: unknown,
  sideChannelText?: string | null,
): string {
  const parts = [JSON.stringify(toolResults ?? [])]
  if (priorDealCards != null) parts.push(JSON.stringify(priorDealCards))
  if (sideChannelText) parts.push(sideChannelText)
  return normalizeForTrace(parts.join(' '))
}

/** True when the matched entity string appears verbatim in the grounding corpus. */
export function isTraceableToTools(match: string, corpus: string): boolean {
  const needle = normalizeForTrace(match)
  if (!needle) return false
  return corpus.includes(needle)
}

// ── Brief 43 PR 10: this turn's lookups ─────────────────────────────────────

export interface SideLookups {
  /** This turn's ACRIS block, from its header to the next blank line. */
  acris: string | null
  dob: boolean
  streetEasy: boolean
}

export interface GuardGrounding {
  /** Normalized: tool results + prior turn's cards + side-lookup blocks (entity names). */
  corpus: string
  /** Normalized: this turn's tool results only (source names). */
  toolCorpus: string
  lookups: SideLookups
}

// The blocks composeContext writes (lib/chat/context/*): each starts on its own
// line after a blank one. The ACRIS block (lib/acris.ts formatForChat, plus any
// note lines) has no blank line inside it.
export function findSideLookups(sideText: string | null | undefined): SideLookups {
  const text = sideText ?? ''
  const at = text.search(/^ACRIS PROPERTY RECORDS\b/m)
  let acris: string | null = null
  if (at >= 0) {
    const stop = text.indexOf('\n\n', at)
    acris = text.slice(at, stop === -1 ? undefined : stop)
  }
  return {
    acris,
    dob: /^DOB RECORDS\b/m.test(text),
    streetEasy: /^(?:LIVE STREETEASY LISTINGS\b|Browse (?:all )?matching listings on StreetEasy:)/m.test(text),
  }
}

/**
 * Brief 43 PR 10 — the guard's grounding for a turn: this turn's tool results,
 * the prior turn's cards and this turn's side-lookup blocks (the route's
 * dynamic system block). Not RYAN_MD. Built once per turn.
 */
export function buildGuardGrounding(
  toolResults: ToolResultForVerify[],
  priorDealCards?: unknown,
  sideLookupText?: string | null,
): GuardGrounding {
  return {
    corpus: buildGroundingCorpus(toolResults, priorDealCards, sideLookupText),
    toolCorpus: buildGroundingCorpus(toolResults),
    lookups: findSideLookups(sideLookupText),
  }
}

// A plain corpus string (the pre-PR-10 API): a source name or entity in it is
// grounded, and deed facts never are.
function groundingFromCorpus(corpus: string): GuardGrounding {
  return { corpus, toolCorpus: corpus, lookups: { acris: null, dob: false, streetEasy: false } }
}

function sourceIsGrounded(match: string, g: GuardGrounding): boolean {
  const name = normalizeForTrace(match)
  if (name === 'acris' && g.lookups.acris !== null) return true
  if (name === 'dob' && g.lookups.dob) return true
  if (name === 'streeteasy' && g.lookups.streetEasy) return true
  return isTraceableToTools(match, g.toolCorpus)
}

// Every place the match sits in the reply (a repeated match can be grounded in
// one sentence and not in another). More than 50 counts as not grounded.
function occurrences(text: string, match: string): number[] | null {
  const out: number[] = []
  if (!match) return out
  for (let i = text.indexOf(match); i !== -1; i = text.indexOf(match, i + 1)) {
    if (out.length === 50) return null
    out.push(i)
  }
  return out
}

interface DeedContext {
  text: string
  breaks: Breaks
  blockWords: Set<string>
  blockYears: Set<string>
  blockAmounts: number[]
  hasDeeds: boolean
  hasSale: boolean
}

function deedContext(acris: string | null, response: string): DeedContext | null {
  if (acris === null || !response) return null
  const block = straightApostrophes(acris)
  const text = straightApostrophes(response)
  return {
    text,
    breaks: clauseBreaks(text),
    blockWords: new Set(nameTokens(block)),
    blockYears: new Set(yearsIn(block)),
    blockAmounts: dollarAmounts(block).map(a => a.value),
    hasDeeds: /^(?:Current owner|Last sale|Prior sale):/m.test(block),
    hasSale: /^(?:Last sale|Prior sale):/m.test(block),
  }
}

// The verb words of an owner claim, so what's left is the name it gives.
const OWNER_VERB_WORDS = /\b(?:owned|owner|is|purchased|bought|sold|it|to|acquired|transferred|from|previous|by|them|the|was|were|are|listed|recorded|shown|as|named|being|still|now|currently)\b/gi

/**
 * Brief 43 PR 10 — a deed fact is grounded when this turn's ACRIS block has the
 * deed records it describes:
 * - an owner claim's name ("owner is Jordan Sample") has every word in the
 *   block, in any order (ACRIS writes "SAMPLE, JORDAN"); with no name ("the
 *   owner is an LLC") the block must have deed records;
 * - every dollar figure and year in the claim's clause is in the block ("$1.2M"
 *   for $1,200,000 is fine; the prompt asks for exact prices);
 * - a sale claim needs a sale in the block.
 */
function bindDeedFlag(f: RegexFlag, d: DeedContext | null): boolean {
  if (!d || !d.hasDeeds) return false
  if (f.pattern !== 'ownership_assertion' && !d.hasSale) return false
  if (f.pattern === 'ownership_assertion') {
    // The name is in the match: after the verb, or before "bought it".
    if (!nameTokens(f.match.replace(OWNER_VERB_WORDS, ' ')).every(w => d.blockWords.has(w))) return false
  }
  const spots = occurrences(d.text, straightApostrophes(f.match))
  if (!spots || spots.length === 0) return false
  return spots.every(at => {
    const end = at + f.match.length
    const c = clauseAround(d.text, at, end, d.breaks)
    const clause = c.before + d.text.slice(at, end) + c.after
    if (!yearsIn(clause).every(y => d.blockYears.has(y))) return false
    return dollarAmounts(clause).every(a =>
      d.blockAmounts.some(b => (a.rounded ? Math.abs(a.value - b) <= b * 0.005 : a.value === b)))
  })
}

/**
 * Drop structural flags this turn's grounding supports. URLs, invented stats
 * and action claims always fire. Returns the flags that should still count
 * against the response.
 *
 * `grounding` is a buildGuardGrounding result (Brief 43 PR 10) or, as before,
 * a plain buildGroundingCorpus string. `response` is the reply the flags came
 * from; deed facts can only be grounded with it.
 */
export function filterToolBoundFlags(flags: RegexFlag[], grounding: string | GuardGrounding, response = ''): RegexFlag[] {
  const g = typeof grounding === 'string' ? groundingFromCorpus(grounding) : grounding
  let deed: DeedContext | null | undefined
  const bound = new Map<string, boolean>()
  return flags.filter(f => {
    if (TOOL_BINDABLE_PATTERNS.has(f.pattern)) {
      // Brief 43 PR 10: a source name binds to its own block or this turn's tool results.
      if (f.pattern === 'real_estate_source_citation') return !sourceIsGrounded(f.match, g)
      return !isTraceableToTools(f.match, g.corpus) // grounded entity → drop
    }
    if (DEED_FACT_PATTERNS.has(f.pattern)) {
      const key = `${f.pattern}\u0000${f.match}`
      if (!bound.has(key)) {
        if (deed === undefined) deed = deedContext(g.lookups.acris, response)
        bound.set(key, bindDeedFlag(f, deed))
      }
      return !bound.get(key)
    }
    return true // un-sourceable → keep
  })
}

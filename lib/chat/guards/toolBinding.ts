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
  blockYears: Set<string>
  blockAmounts: number[]
  hasDeeds: boolean
  hasSale: boolean
  /** Name words of the current owner and of the last sale's seller ("sold by"). */
  owner: Set<string> | null
  seller: Set<string> | null
}

function deedContext(acris: string | null, response: string): DeedContext | null {
  if (acris === null || !response) return null
  const block = straightApostrophes(acris)
  const text = straightApostrophes(response)
  return {
    text,
    breaks: clauseBreaks(text),
    blockYears: new Set(yearsIn(block)),
    blockAmounts: dollarAmounts(block).map(a => a.value),
    hasDeeds: /^(?:Current owner|Last sale|Prior sale):/m.test(block),
    hasSale: /^(?:Last sale|Prior sale):/m.test(block),
    owner: partyWords(block.match(/^Current owner:[ \t]{0,3}([^\n]{1,300})/m)?.[1]),
    seller: partyWords(block.match(/\(sold by ([^)\n]{1,300})\)/)?.[1]),
  }
}

function partyWords(name: string | undefined): Set<string> | null {
  const words = name ? nameTokens(name) : []
  return words.length > 0 ? new Set(words) : null
}

// Brief 43 PR 10 review: which party an owner claim names. "The owner is …" /
// "owned by …" (not "was owned by", "the previous owner is …") is the current
// owner; "previous owner …" / "transferred from …" is the last sale's seller;
// a buyer verb ("sold to", "bought by", "<Name> bought it") may be either.
const PAST_BEFORE = /\b(?:previous|prior|former|original|old|earlier|was|were|been|previously|formerly|once|originally)\s{1,3}$/i
function partiesFor(match: string, before: string, d: DeedContext): Array<Set<string> | null> {
  if (/^(?:previous\s{1,3}owner|transferred\s{1,3}from)\b/i.test(match)) return [d.seller]
  if (/^(?:owner\s{1,3}is|owned\s{1,3}by)\b/i.test(match) && !PAST_BEFORE.test(before.slice(-24))) return [d.owner]
  return [d.owner, d.seller]
}

// "<Name> bought / purchased / acquired …" (regexGuard's second owner pattern).
const BUYER_FIRST = /^(?!(?:owned|owner|purchased|bought|sold|acquired|transferred|previous)\b)[A-Z][^ ]{0,40}(?: [A-Z][^ ]{0,40}){0,3} (?:bought|purchased|acquired) /

// The verb words of an owner claim, so what's left is the name it gives.
const OWNER_VERB_WORDS = /\b(?:owned|owner|is|purchased|bought|sold|it|to|acquired|transferred|from|previous|by|them|the|was|were|are|listed|recorded|shown|as|named|being|still|now|currently)\b/gi

/**
 * Brief 43 PR 10 — a deed fact is grounded when this turn's ACRIS block has the
 * deed records it describes:
 * - an owner claim's name ("owner is Jordan Sample") has every word in one
 *   party's name in the block, in any order (ACRIS writes "SAMPLE, JORDAN"):
 *   the current owner for "owner is", the seller for "previous owner", either
 *   for a buyer verb; with no name ("the owner is an LLC") the block must have
 *   deed records;
 * - every dollar figure and year in the claim's clause is in the block ("$1.2M"
 *   for $1,200,000 is fine; the prompt asks for exact prices);
 * - a sale claim needs a sale in the block.
 */
function bindDeedFlag(f: RegexFlag, d: DeedContext | null): boolean {
  if (!d || !d.hasDeeds) return false
  if (f.pattern !== 'ownership_assertion' && !d.hasSale) return false
  // The name is in the match: after the verb, or before "bought it". Brief 43
  // PR 10 review r2: in "<Name> bought the 3-family", what was bought isn't
  // part of the name.
  const nameText = BUYER_FIRST.test(f.match) ? f.match.replace(/ (?:bought|purchased|acquired) .*$/, '') : f.match
  const named = f.pattern === 'ownership_assertion' ? nameTokens(nameText.replace(OWNER_VERB_WORDS, ' ')) : []
  const spots = occurrences(d.text, straightApostrophes(f.match))
  if (!spots || spots.length === 0) return false
  return spots.every(at => {
    const end = at + f.match.length
    // Brief 43 PR 10 review: every name word must belong to one party the block
    // names, in the role the claim gives it: not words gathered from the whole
    // block (its address, the lender, labels), and not the seller called the
    // current owner [engineering precaution].
    if (named.length > 0 && !partiesFor(f.match, d.text.slice(Math.max(0, at - 24), at), d)
      .some(p => p !== null && named.every(w => p.has(w)))) return false
    const c = clauseAround(d.text, at, end, d.breaks)
    const clause = c.before + d.text.slice(at, end) + c.after
    if (!yearsIn(clause).every(y => d.blockYears.has(y))) return false
    return dollarAmounts(clause).every(a =>
      d.blockAmounts.some(b => (a.rounded ? Math.abs(a.value - b) <= b * 0.005 : a.value === b)))
  })
}

// Brief 43 PR 10 (S-09): "Three of them are owned by LLCs" about this turn's
// CRM sellers. An owner claim that names no one and only says "an LLC" or
// "LLCs" is grounded when this turn's results or lookups hold an LLC; with none
// it's still a claim with no source [engineering precaution].
const LLC_AFTER = /^\s{1,3}(?:(?:an?|the|two|three|four|several|separate|different)\s{1,3})?(?:LLCs?|L\.L\.C\.?)(?!\w)/i
function llcOwnedGrounded(f: RegexFlag, g: GuardGrounding, response: string): boolean {
  if (f.pattern !== 'ownership_assertion' || !/^(?:owned\s{1,3}by|owner\s{1,3}is)$/i.test(f.match) || !/\bllc\b/.test(g.corpus)) return false
  const text = straightApostrophes(response)
  const spots = occurrences(text, f.match)
  return !!spots && spots.length > 0 && spots.every(at => LLC_AFTER.test(text.slice(at + f.match.length, at + f.match.length + 40)))
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
        bound.set(key, bindDeedFlag(f, deed) || llcOwnedGrounded(f, g, response))
      }
      return !bound.get(key)
    }
    return true // un-sourceable → keep
  })
}

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
import type { RegexFlag } from './regexGuard'
import type { ToolResultForVerify } from './llmVerifier'

// Structural patterns whose matches are "specific entity claims" that can
// LEGITIMATELY appear in tool output (a party/owner name, incl. an LLC-held
// Mojo seller lead). Only these are eligible for the tool-output exemption.
// All other patterns stay hard fails.
export const TOOL_BINDABLE_PATTERNS = new Set<string>(['corporate_entity'])

// Normalize for a forgiving substring trace: lowercase, non-alphanumerics → a
// single space. So "Tompkins Mazal Bh 101 LLC" in the response matches
// "tompkins mazal bh 101 llc" wherever it sits inside the tool-output JSON,
// regardless of surrounding punctuation/quoting.
export function normalizeForTrace(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Flatten this turn's tool outputs (+ optionally the prior turn's DEAL CARDS)
 * into one normalized string the trace check greps against. Built once per turn
 * — tool results don't change across guard retries.
 */
export function buildGroundingCorpus(
  toolResults: ToolResultForVerify[],
  priorDealCards?: unknown,
): string {
  const parts = [JSON.stringify(toolResults ?? [])]
  if (priorDealCards != null) parts.push(JSON.stringify(priorDealCards))
  return normalizeForTrace(parts.join(' '))
}

/** True when the matched entity string appears verbatim in the grounding corpus. */
export function isTraceableToTools(match: string, corpus: string): boolean {
  const needle = normalizeForTrace(match)
  if (!needle) return false
  return corpus.includes(needle)
}

/**
 * Drop tool-bindable structural flags whose matched text is grounded in the
 * corpus. Non-bindable patterns (URLs, source citations, ownership verbs,
 * invented stats, dated amounts) are passed through untouched — they always
 * fire. Returns the flags that should still count against the response.
 */
export function filterToolBoundFlags(flags: RegexFlag[], corpus: string): RegexFlag[] {
  return flags.filter(f => {
    if (!TOOL_BINDABLE_PATTERNS.has(f.pattern)) return true // un-sourceable → keep
    return !isTraceableToTools(f.match, corpus) // grounded entity → drop
  })
}

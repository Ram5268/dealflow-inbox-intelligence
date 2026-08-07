// Brief 5.1, Step 3 — hallucination-guard retry scaffolding.
//
// Pure helpers for the informed-retry loop wired into app/api/chat/route.ts:
// the feedback prompt fed back to Sonnet, the canned fallback used after
// retries are exhausted, and the telemetry types stored on
// DriftInteraction.parsedFilters.guard. The actual API orchestration lives in
// the route (it needs the live Anthropic client + systemBlocks closures).
import type { RegexFlag } from './regexGuard'
import type { VerifierFlag } from './llmVerifier'

// total attempts = 1 initial + MAX_GUARD_RETRIES informed retries.
export const MAX_GUARD_RETRIES = 2

// Shown to Ryan when the guard can't get a verified answer after all retries.
export const CANNED_FALLBACK = `I can't produce a fully verified answer for that. Drift only has access to your inbox listings + parties (currently seed data in test mode). If you're asking about public records, MLS/RLS/StreetEasy data, ownership history, or comps from external sources, I don't have that access.

Try rephrasing to ask about a listing or party in the system — I can help with those.`

// One entry per guard attempt (attempt 0 = initial response, 1+ = retries).
export interface GuardAttempt {
  attempt: number
  regexFlags: RegexFlag[]
  verifierFlags: VerifierFlag[]
  verifierCost: number
}

// Stored under parsedFilters.guard — Ryan reads this in production to see
// baseline guard behavior even on clean (non-triggered) queries.
export interface GuardTelemetry {
  enabled: boolean
  finalAttempt: number
  fellbackToCanned: boolean
  history: GuardAttempt[]
  totalVerifierCostUsd: number
}

// Turn structural + semantic flags into the bulleted list handed back to Sonnet.
export function formatFlagLines(regexFlags: RegexFlag[], verifierFlags: VerifierFlag[]): string[] {
  return [
    ...regexFlags.map(f => `Structural: '${f.match}' (${f.pattern})`),
    ...verifierFlags.map(f => `Semantic: '${f.claim}' — ${f.reason}`),
  ]
}

// The user turn appended on an informed retry. Compact by design — every token
// here is paid on each retry.
export function buildFeedbackPrompt(flagLines: string[]): string {
  return `Your previous response contained claims not supported by tool results:

<flags>
${flagLines.map(l => `- ${l}`).join('\n')}
</flags>

Regenerate the response. Remove those claims. Only state facts present in the tool results above. If the user is asking for data outside what your tools return (public records, MLS, external sites, ownership history, comps), say plainly that this system doesn't have that data — do not invent alternatives.`
}

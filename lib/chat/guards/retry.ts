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

// Brief 5.1.1, Fix 3 — contextual canned fallbacks.
// After retries are exhausted, the fallback message should match WHAT the guard
// actually flagged instead of always assuming a public-records ask. Ryan's trial
// showed a mortgage-math question (F04) and a system-capability question (MT2)
// both getting the public-records boilerplate — wrong for the situation.
//
// selectCannedFallback inspects the final attempt's flag text and picks one of
// four variants. Order matters: the most specific/consequential intents
// (public-records citations, then finance math) are matched before the softer
// self-description and generic buckets.
export const CANNED_PUBLIC_RECORDS = `I'm afraid I can't give you a verified answer on that one. This system doesn't reach into public records, MLS, RLS, StreetEasy, or the external property databases; only your inbox listings and parties are in view. If you'd like, rephrase around a listing or party in the system and I'll pick it up.`

export const CANNED_FINANCE = `I'm afraid the math isn't something I can verify from what's in the system. The figures I would need — square footage, maintenance, purchase price, tax details — are not in the data. Share the missing inputs and I'll run the calculation, or the offering plan and managing agent should have them on hand.`

export const CANNED_SELF_DESCRIPTION = `A quick summary. I search your listings and your parties through two tools, search_listings and search_parties, against the database. I can find matches, compare them, and draft outreach. I can't send email, and I don't have live public-records access. Ask me about a listing, a buyer, or a match, and I'll pick it up.`

export const CANNED_GENERIC = `I'm afraid I couldn't verify that one. If you'd like, rephrase around a specific listing, party, or match in the system and I'll take another pass.`

// Back-compat alias — the generic variant is the closest analogue to the old
// single message. Retained so any external caller importing CANNED_FALLBACK
// keeps working; the route now uses selectCannedFallback.
export const CANNED_FALLBACK = CANNED_GENERIC

/**
 * Pick the fallback message that best matches what the guard flagged on the
 * final attempt. Concatenates all flag text (regex pattern+match and verifier
 * claim) and matches against intent buckets in priority order.
 */
export function selectCannedFallback(finalAttemptFlags: {
  regexFlags: RegexFlag[]
  verifierFlags: VerifierFlag[]
}): string {
  const allFlagText = [
    ...finalAttemptFlags.regexFlags.map(f => `${f.pattern} ${f.match}`),
    ...finalAttemptFlags.verifierFlags.map(f => `${f.claim} ${f.reason}`),
  ]
    .join(' ')
    .toLowerCase()

  // Public-records / MLS-style ask (ownership, external sources, sale history).
  if (/acris|propertyshark|streeteasy|zillow|trulia|realtor|redfin|corelogic|\bmls\b|\brls\b|\bdob\b|owner|ownership|zoning|sale.?history|last sold|transfer|deed/.test(allFlagText)) {
    return CANNED_PUBLIC_RECORDS
  }
  // Financial calculation with insufficient data.
  if (/cap rate|\bnoi\b|mortgage|closing cost|mansion tax|transfer tax|\btax\b|maintenance|common charge|sqft|square f|price per|\$\/sqft/.test(allFlagText)) {
    return CANNED_FINANCE
  }
  // Self-description / capability question.
  if (/drift|assistant|capabilit|\btools?\b|\bcrm\b|mojo|inbox|database|calendar|\bsearch_/.test(allFlagText)) {
    return CANNED_SELF_DESCRIPTION
  }
  return CANNED_GENERIC
}

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

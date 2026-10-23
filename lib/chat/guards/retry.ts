// Brief 5.1, Step 3 — hallucination-guard retry scaffolding.
//
// Pure helpers for the informed-retry loop wired into app/api/chat/route.ts:
// the feedback prompt fed back to Sonnet, the canned fallback used after
// retries are exhausted, and the telemetry types stored on
// DriftInteraction.parsedFilters.guard. The actual API orchestration lives in
// the route (it needs the live Anthropic client + systemBlocks closures).
import type { RegexFlag } from './regexGuard'
import type { VerifierFlag, VerifierResult } from './llmVerifier'

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
// self-description and generic buckets. Brief 43 PR 2 puts the never-sent
// reply ahead of all four.
export const CANNED_PUBLIC_RECORDS = `I'm afraid I can't give you a verified answer on that one. This system doesn't reach into public records, MLS, RLS, StreetEasy, or the external property databases; only your inbox listings and parties are in view. If you'd like, rephrase around a listing or party in the system and I'll pick it up.`

export const CANNED_FINANCE = `I'm afraid the math isn't something I can verify from what's in the system. The figures I would need — square footage, maintenance, purchase price, tax details — are not in the data. Share the missing inputs and I'll run the calculation, or the offering plan and managing agent should have them on hand.`

export const CANNED_SELF_DESCRIPTION = `A quick summary. I search your listings and your parties through two tools, search_listings and search_parties, against the database. I can find matches, compare them, and draft outreach. I can't send email, and I don't have live public-records access. Ask me about a listing, a buyer, or a match, and I'll pick it up.`

export const CANNED_GENERIC = `I'm afraid I couldn't verify that one. If you'd like, rephrase around a specific listing, party, or match in the system and I'll take another pass.`

// Brief 43 PR 2 (Q2) — the fixed reply when Drift claims a second time that it
// sent, texted, called or booked something (an `action_claim` flag on the
// rewrite too). Nothing contacts anyone [Ryan, 2026-09-24]; the wording is
// Brief 43's (DRIFT_SCRIPT #20, test case D-02).
export const NEVER_SENT_REPLY = `I can't send anything. The draft is ready for you to copy.`

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

  // Brief 43 PR 2: a send / call / booking claim gets the never-sent reply,
  // whatever else was flagged with it.
  if (finalAttemptFlags.regexFlags.some(f => f.pattern === 'action_claim')) {
    return NEVER_SENT_REPLY
  }
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
  // Brief 43 PR 15 (Q31): the fact-check was skipped on a fact-free reply (factFree.ts).
  verifierSkipped?: 'fact_free'
  verifierCost: number
}

/**
 * Brief 43 PR 2 — "the second failure gets a fixed reply": true when the latest
 * attempt carries an `action_claim` flag and an earlier attempt did too. The
 * route then returns NEVER_SENT_REPLY instead of paying for another rewrite.
 */
export function repeatedActionClaim(history: Array<Pick<GuardAttempt, 'regexFlags'>>): boolean {
  const claims = (a: Pick<GuardAttempt, 'regexFlags'>) => a.regexFlags.some(f => f.pattern === 'action_claim')
  if (history.length < 2 || !claims(history[history.length - 1])) return false
  return history.slice(0, -1).some(claims)
}

/**
 * Brief 43 PR 2 — true when this attempt's regex flags make it a repeated
 * action claim. The reply then becomes NEVER_SENT_REPLY whatever the fact-check
 * says, so the route skips that (paid) verifier call.
 */
export function skipVerifierForRepeatClaim(
  history: Array<Pick<GuardAttempt, 'regexFlags'>>,
  regexFlags: RegexFlag[],
): boolean {
  return repeatedActionClaim([...history, { regexFlags }])
}

/** What the guard records for an attempt whose fact-check was skipped (no flags, no cost). */
export function skippedVerification(): VerifierResult {
  return { isGrounded: false, flags: [], costUsd: 0, latencyMs: 0 }
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

// Brief 43 PR 2 — added to the retry feedback when an `action_claim` was
// flagged [Ryan, 2026-09-24: nothing contacts anyone].
const ACTION_CLAIM_FEEDBACK = `Nothing was sent. You can't send, text, email or call anyone, invite anyone, book anything or add anything to a calendar, so never say or suggest that it was done or will be done ("Sent", "Done", "on its way", "I've texted them"). Say plainly that you can't send it; if there's a draft, say it's ready for Ryan to copy.`

// The user turn appended on an informed retry. Compact by design — every token
// here is paid on each retry.
export function buildFeedbackPrompt(flagLines: string[]): string {
  const prompt = `Your previous response contained claims not supported by tool results:

<flags>
${flagLines.map(l => `- ${l}`).join('\n')}
</flags>

Regenerate the response. Remove those claims. Only state facts present in the tool results above. If the user is asking for data outside what your tools return (public records, MLS, external sites, ownership history, comps), say plainly that this system doesn't have that data — do not invent alternatives.`
  // formatFlagLines renders a regex flag as "Structural: '<match>' (<pattern>)".
  if (!flagLines.some(l => l.endsWith('(action_claim)'))) return prompt
  return `${prompt}\n\n${ACTION_CLAIM_FEEDBACK}`
}

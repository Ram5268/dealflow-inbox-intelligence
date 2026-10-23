// Brief 5.1, Step 3 — hallucination-guard retry scaffolding.
//
// Pure helpers for the informed-retry loop wired into app/api/chat/route.ts:
// the feedback prompt fed back to Sonnet, the canned fallback used after
// retries are exhausted, and the telemetry types stored on
// DriftInteraction.parsedFilters.guard. The actual API orchestration lives in
// the route (it needs the live Anthropic client + systemBlocks closures).
import type { RegexFlag } from './regexGuard'
import type { VerifierError, VerifierFlag, VerifierResult } from './llmVerifier'

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
//
// Brief 43 PR 10 (Q18; N11): the four texts say what Drift really can do. They
// used to deny the deed and permit lookups it has ("This system doesn't reach
// into public records") and to name its tools. Deed owners may be named: D1
// [Ryan, 2026-10-17]. Wording follows the feel standard (Brief 42 TEST_PLAN
// §3): calm, short, one useful offer, no em-dashes, no "I'm afraid", no tool or
// system names; the self-description follows DRIFT_SCRIPT #2 and D3 ("Drift,
// DealFlow's assistant").
export const CANNED_PUBLIC_RECORDS = `I couldn't confirm that from the records I have, so I'd rather not guess. I can look up deed and permit records for an exact address, but I can't browse other websites or the MLS. Which address should I check?`

export const CANNED_FINANCE = `I couldn't check that math against the figures on file, so I'd rather not give a number. Share the price, the down payment and any monthly charges, and I'll run the numbers.`

export const CANNED_SELF_DESCRIPTION = `I'm Drift, DealFlow's assistant. I can search your listings and buyer and renter requests, look up one of your CRM sellers by name or address, build Buyer Match reports, draft emails and texts for you to send, and look up deed and permit records and today's mortgage rate. I can't send anything, make calls, book your calendar while Outlook is off, or browse other websites. Where would you like to start?`

export const CANNED_GENERIC = `I couldn't verify part of that answer, so I'd rather not guess. Ask me about a specific listing, buyer or address and I'll take another pass.`

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
  verifierCost: number
  // Brief 43 PR 10 (Q32): the fact-check failed or answered garbage on this
  // attempt, so its reply was accepted on the regex check alone.
  verifierError?: VerifierError
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
//
// Brief 43 PR 10 (Q18): it no longer tells Drift to deny public records. The
// deed, permit and live StreetEasy blocks in the system prompt are real data;
// what's missing is a source this turn didn't fetch. Links reach Ryan as
// buttons, so the rewrite never writes a URL.
export function buildFeedbackPrompt(flagLines: string[]): string {
  const prompt = `Your previous response contained claims that this turn's tool results and record blocks don't support:

<flags>
${flagLines.map(l => `- ${l}`).join('\n')}
</flags>

Regenerate the response. Remove those claims, or restate them exactly as the tool results or the record blocks above give them. Name a source (city records, StreetEasy) only when its block is above, and never write a URL: links reach Ryan as buttons. If Ryan asked for something you don't have this turn (another website, the MLS, comps, or records for an address that wasn't looked up), say so in one short sentence and offer one next step. Don't invent alternatives.`
  // formatFlagLines renders a regex flag as "Structural: '<match>' (<pattern>)".
  if (!flagLines.some(l => l.endsWith('(action_claim)'))) return prompt
  return `${prompt}\n\n${ACTION_CLAIM_FEEDBACK}`
}

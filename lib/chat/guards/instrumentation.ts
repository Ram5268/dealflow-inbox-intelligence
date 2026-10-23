// Brief 11.0, Fix #2 — guard-fire instrumentation.
//
// One GuardFireEvent row per guarded chat turn. The retry loop itself lives in
// app/api/chat/route.ts (it needs the live Anthropic client); this module owns
// the verdict derivation + the best-effort write. The write is fire-and-forget:
// a logging failure is swallowed so instrumentation can never block or break a
// chat response.
import { prisma } from '@/lib/prisma'
import type { GuardTelemetry } from './retry'
import { formatFlagLines } from './retry'

// 'timeout' (Brief 43 PR 4): the turn ran out of time before Drift had a reply.
export type GuardVerdict = 'pass' | 'retry' | 'refuse' | 'canned_fallback' | 'timeout'

/**
 * Map the guard's telemetry into a single verdict label:
 *   - canned_fallback: retries exhausted, honest-decline returned
 *   - pass:            clean on the first attempt (no retries)
 *   - retry:           flagged then regenerated to a grounded response
 */
export function deriveVerdict(t: GuardTelemetry): GuardVerdict {
  if (t.fellbackToCanned) return 'canned_fallback'
  if (t.finalAttempt === 0) return 'pass'
  return 'retry'
}

// Flag text from the first flagged attempt: the reason this turn tripped the guard (if
// it did). Empty string when the turn passed clean.
export function summarizeReason(t: GuardTelemetry): string {
  // Brief 43 PR 15 (Q35): it used to be the final attempt's flags, which are
  // empty after a retry that ended clean, so no retry ever had a reason.
  // (`last` is the attempt the reason is read from.)
  const last = t.history.find(h => h.regexFlags.length > 0 || h.verifierFlags.length > 0) ?? t.history[t.history.length - 1]
  if (!last) return ''
  return formatFlagLines(last.regexFlags, last.verifierFlags).join(' | ')
}

export interface GuardFireEventInput {
  organizationId: string
  sessionId: string
  userTurn: string
  priorAssistantTurn: string | null
  assistantAttempt: string // what Sonnet first tried to say (pre-correction)
  toolCallsAttempted: unknown // [{ name, input, totalMatched, cardIds }]
  telemetry: GuardTelemetry
  finalResponseSent: string | null
  // Brief 43 PR 4: set for a row the telemetry can't describe (a timed-out turn).
  verdict?: GuardVerdict
  reason?: string
}

/**
 * Brief 43 PR 4 (Q4; Z-05): the row for a turn that ran out of time before
 * Drift had a reply, so timeouts show up in the guard log (they used to write
 * none). Counts only: no message text and no tool inputs, just which tools ran,
 * how many results each had, and how long the turn took. sessionId is '' when
 * no chat was saved (the column is required and has no foreign key).
 */
export function timedOutGuardInput(input: {
  organizationId: string
  sessionId: string | null
  elapsedMs: number
  toolCalls: Array<{ name: string; totalMatched: number }>
  finalResponseSent: string
  streetEasy?: { searches: number; listings: number } // Brief 43 PR 15
}): GuardFireEventInput {
  const n = input.toolCalls.length
  return {
    organizationId:     input.organizationId,
    sessionId:          input.sessionId ?? '',
    userTurn:           '',
    priorAssistantTurn: null,
    assistantAttempt:   '',
    toolCallsAttempted: [
      ...input.toolCalls.map(c => ({ name: c.name, totalMatched: c.totalMatched })),
      ...streetEasyLog(input.streetEasy?.searches ?? 0, input.streetEasy?.listings ?? 0),
    ],
    telemetry:          { enabled: true, finalAttempt: 0, fellbackToCanned: false, history: [], totalVerifierCostUsd: 0 },
    finalResponseSent:  input.finalResponseSent,
    verdict:            'timeout',
    reason:             `timed out after ${(input.elapsedMs / 1000).toFixed(1)} s with ${n} tool call${n === 1 ? '' : 's'}`,
  }
}

/**
 * Brief 43 PR 15 (Q37; Brief 42 Z-07): the live StreetEasy searches this turn's
 * side lookup ran (each is at most one RapidAPI request, from the monthly
 * quota), as an entry after the tool calls in the guard row's
 * toolCallsAttempted. Counts only: no neighbourhoods, prices or links. None
 * when no search ran.
 */
export function streetEasyLog(searches: number, listings: number): Array<{ name: 'streeteasy_search'; searches: number; listings: number }> {
  return searches > 0 ? [{ name: 'streeteasy_search', searches, listings }] : []
}

/**
 * Write one GuardFireEvent row. Never throws — on any DB error it logs and
 * returns, so the chat route proceeds regardless. Awaitable so callers can
 * choose to await inside their own try/catch, but failures are self-contained.
 */
export async function logGuardFireEvent(input: GuardFireEventInput): Promise<void> {
  try {
    await prisma.guardFireEvent.create({
      data: {
        organizationId:     input.organizationId,
        sessionId:          input.sessionId,
        userTurn:           input.userTurn,
        priorAssistantTurn: input.priorAssistantTurn,
        assistantAttempt:   input.assistantAttempt,
        toolCallsAttempted: input.toolCallsAttempted as object,
        verifierVerdict:    input.verdict ?? deriveVerdict(input.telemetry),
        verifierReason:     input.reason ?? (summarizeReason(input.telemetry) || null),
        finalResponseSent:  input.finalResponseSent,
      },
    })
  } catch (err) {
    console.error('[DealFlow] GuardFireEvent logging failed (non-fatal):', err)
  }
}

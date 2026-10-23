// Brief 43 PR 4 (Q4; M23, M32): the chat turn's time budget [engineering precaution].
//
// Vercel stops /api/chat at 60 s (maxDuration) and sends back an HTML 504. The
// turn used to have no deadline of its own: the side lookups waited on outside
// services with no timeout, then up to 6 tool rounds, a forced reply, 2 guard
// rewrites and 3 fact-checks ran one after another. Spot check #4 ("any coming
// soon in bedstuy?") hit 60.7 s, showed "Something went wrong" and left an
// empty chat. The budget, all measured from the request's start:
//   - every outside fetch in a side lookup: LOOKUP_TIMEOUT_MS (6 s);
//   - past TURN_SOFT_MS (40 s): no more tool rounds; Drift writes its reply;
//   - past TURN_HARD_MS (50 s): no new model call (no fact-check, no rewrite,
//     no chat title); the reply goes out regex-checked only;
//   - at TURN_CEILING_MS (52 s): any model call or tool round still running is
//     cut off, and the turn ends with TIMED_OUT_REPLY. The 8 s left before
//     Vercel's limit cover the database writes after it and a cold start.
// Brief 43 PR 11 reuses withTimeout / fetchWithTimeout for the city-records lookups.
import { AsyncLocalStorage } from 'node:async_hooks'

export const LOOKUP_TIMEOUT_MS = 6_000
export const TURN_SOFT_MS = 40_000
export const TURN_HARD_MS = 50_000
export const TURN_CEILING_MS = 52_000

// Drift's stock reply when the turn ran out of time before it had an answer
// (Brief 43 PR 4's wording).
export const TIMED_OUT_REPLY = "I couldn't finish that; try a narrower question."

// ── withTimeout ───────────────────────────────────────────────────────────────

/** What withTimeout gives back when the promise didn't settle in time. */
export class TimedOut {
  readonly timedOut = true
  constructor(readonly label: string, readonly ms: number) {}
}

export function isTimedOut(value: unknown): value is TimedOut {
  return value instanceof TimedOut
}

/**
 * Wait at most `ms` for `p`. Resolves to p's value, or to a TimedOut when time
 * runs out; a rejection passes through. p itself keeps running (a promise can't
 * be cancelled); pass an AbortSignal to the work as well when it takes one.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | TimedOut> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<TimedOut>(resolve => {
    timer = setTimeout(() => resolve(new TimedOut(label, ms)), Math.max(0, ms))
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

// ── fetchWithTimeout ──────────────────────────────────────────────────────────

/** The error a fetchWithTimeout that ran out of time fails with. */
export class LookupTimeoutError extends Error {
  constructor(readonly host: string, readonly ms: number) {
    super(`${host} didn't answer within ${ms} ms`)
    this.name = 'LookupTimeoutError'
  }
}

export function isLookupTimeout(e: unknown): e is LookupTimeoutError {
  return e instanceof LookupTimeoutError
}

// The side lookup a fetch runs in (composeContext's runFetcher), so a timeout
// deep inside lib/acris.ts or lib/dobLookup.ts, whose own code turns failures
// into "no data", still reaches Drift as "didn't answer in time".
const lookupScope = new AsyncLocalStorage<LookupTally>()
export interface LookupTally { timeouts: number }

/** Run fn; every fetchWithTimeout inside it that times out adds 1 to tally. */
export function tallyLookupTimeouts<T>(tally: LookupTally, fn: () => Promise<T>): Promise<T> {
  return lookupScope.run(tally, fn)
}

function hostOf(url: string | URL): string {
  // The host only: a query string can carry a key (FRED's api_key).
  try { return new URL(String(url)).host } catch { return 'an outside service' }
}

/**
 * fetch with an AbortSignal that fires after `ms` (default LOOKUP_TIMEOUT_MS),
 * merged with the caller's own signal. Times the wait for the response
 * headers; a fetch that runs out of time fails with a LookupTimeoutError.
 */
export async function fetchWithTimeout(url: string | URL, init: RequestInit = {}, ms: number = LOOKUP_TIMEOUT_MS): Promise<Response> {
  const tally = lookupScope.getStore()
  const controller = new AbortController()
  const timer = setTimeout(() => {
    if (tally) tally.timeouts++
    controller.abort(new LookupTimeoutError(hostOf(url), ms))
  }, ms)
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal
  try {
    return await fetch(url, { ...init, signal })
  } catch (e) {
    if (controller.signal.aborted) throw controller.signal.reason
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** The one-line note Drift gets in place of a side lookup that ran out of time. */
export function lookupTimeoutNote(source: string): string {
  return `\n\nLOOKUP NOTE: ${source} didn't answer in time, so it's missing here. If the question needed it, tell Ryan in one short line.`
}

// ── The turn's clock ──────────────────────────────────────────────────────────

export interface TurnBudget {
  elapsedMs(): number
  pastSoft(): boolean
  pastHard(): boolean
  /** ms left until `atMs` after the start (0 once past it). */
  msLeft(atMs: number): number
}

export function createTurnBudget(
  startMs: number,
  limits: { softMs: number; hardMs: number },
  now: () => number = () => Date.now(),
): TurnBudget {
  const elapsedMs = () => now() - startMs
  return {
    elapsedMs,
    pastSoft: () => elapsedMs() >= limits.softMs,
    pastHard: () => elapsedMs() >= limits.hardMs,
    msLeft: (atMs: number) => Math.max(0, atMs - elapsedMs()),
  }
}

/**
 * An AbortSignal that fires in `ms`, for the SDKs' `{ signal }` request option
 * (an aborted Anthropic/OpenAI call fails at once and isn't retried). The timer
 * doesn't keep the process alive.
 */
export function deadlineSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`out of time after ${ms} ms`)), Math.max(0, ms))
  ;(timer as { unref?: () => void }).unref?.()
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

import { PRE_RETRIEVAL_FETCHERS, POST_RETRIEVAL_FETCHERS, FETCHER_SOURCES } from './registry'
import type { ContextFetcher, ContextInput, ContextResult, LiveSeListing } from './types'
import { withTimeout, isTimedOut, tallyLookupTimeouts, lookupTimeoutNote, type LookupTally } from '../turnBudget'
import { mortgageFetcher } from './mortgage'
import { calendarFetcher } from './calendar'

// Brief 43 PR 4 (Q4; M32): the most one side lookup may take. Its outside
// fetches give up sooner (LOOKUP_TIMEOUT_MS, 6 s); this also covers a slow
// database read or a chain of fetches [engineering precaution].
export const FETCHER_TIMEOUT_MS = 10_000

export interface ComposedContext {
  pre:            string              // concat of all PRE-retrieval fetcher blocks
  post:           string              // concat of all POST-retrieval fetcher blocks
  liveSeListings: LiveSeListing[]     // structured payload from liveStreetEasy fetcher
  seFilterUrl:    string | null       // structured payload from liveStreetEasy fetcher
  // Brief 43 PR 15 (Q31): how many side lookups brought this message's own
  // facts (the fact-check is skipped only when none did; guards/factFree.ts).
  factLookups:    number
  // Brief 43 PR 15 (Q37): live StreetEasy searches run, for the guard log.
  streetEasySearches: number
}

// Brief 43 PR 15: blocks that come with every turn, whatever the message: today's
// mortgage rate (a number, which a reply with no digits or number words can't
// repeat) and the calendar's line (the paused note while Outlook is paused;
// calendar events aren't among the fact-check's topics, llmVerifier.ts). Every
// other block counts as this message's facts, a lookup's timeout note included
// [engineering precaution].
const EVERY_TURN = new Set<ContextFetcher>([mortgageFetcher, calendarFetcher])

// Brief 43 PR 4: a lookup that runs out of time, or whose outside fetch did,
// gives Drift a one-line note ("live StreetEasy didn't answer in time") instead
// of holding up the turn. It keeps what it did get.
async function runFetcher(f: ContextFetcher, input: ContextInput): Promise<ContextResult> {
  const source = FETCHER_SOURCES.get(f) ?? 'a side lookup'
  const tally: LookupTally = { timeouts: 0 }
  try {
    const result = await withTimeout(tallyLookupTimeouts(tally, () => f(input)), FETCHER_TIMEOUT_MS, source)
    if (isTimedOut(result)) return { block: lookupTimeoutNote(source) }
    if (tally.timeouts > 0) return { ...result, block: (result.block ?? '') + lookupTimeoutNote(source) }
    return result
  } catch (e) {
    console.error('[context] fetcher failed:', e instanceof Error ? e.message : e)
    return { block: tally.timeouts > 0 ? lookupTimeoutNote(source) : null }
  }
}

function collectStructured(results: ContextResult[]): { liveSeListings: LiveSeListing[]; seFilterUrl: string | null } {
  let liveSeListings: LiveSeListing[] = []
  let seFilterUrl: string | null = null
  for (const r of results) {
    if (r.liveSeListings) liveSeListings = r.liveSeListings
    if (r.seFilterUrl !== undefined) seFilterUrl = r.seFilterUrl
  }
  return { liveSeListings, seFilterUrl }
}

export async function composeContext(input: ContextInput): Promise<ComposedContext> {
  // Run pre and post groups in parallel — per-fetcher failures isolated by runFetcher,
  // and each one bounded by FETCHER_TIMEOUT_MS (Brief 43 PR 4).
  const [preResults, postResults] = await Promise.all([
    Promise.all(PRE_RETRIEVAL_FETCHERS.map(f => runFetcher(f, input))),
    Promise.all(POST_RETRIEVAL_FETCHERS.map(f => runFetcher(f, input))),
  ])

  const pre  = preResults .map(r => r.block).filter((b): b is string => b !== null).join('')
  const post = postResults.map(r => r.block).filter((b): b is string => b !== null).join('')

  // Currently only liveStreetEasy populates structured fields, and it lives in PRE.
  // Check both groups for forward compatibility.
  const { liveSeListings, seFilterUrl } = collectStructured([...preResults, ...postResults])

  const fetchers = [...PRE_RETRIEVAL_FETCHERS, ...POST_RETRIEVAL_FETCHERS]
  const results = [...preResults, ...postResults]
  const factLookups = results.filter((r, i) => r.block && !EVERY_TURN.has(fetchers[i])).length
  const streetEasySearches = results.reduce((n, r) => n + (r.streetEasySearches ?? 0), 0)

  return { pre, post, liveSeListings, seFilterUrl, factLookups, streetEasySearches }
}

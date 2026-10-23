import type { ContextFetcher } from './types'
import { mortgageFetcher }       from './mortgage'
import { acrisFetcher }          from './acris'
import { dobFetcher }            from './dob'
import { calendarFetcher }       from './calendar'
import { matchesFetcher }        from './matches'
import { liveStreetEasyFetcher } from './liveStreetEasy'
import { mojoFetcher }           from './mojo'

// Two-group split: PRE runs before retrievalResult.context, POST runs after.
// This mirrors the system-prompt concatenation order that route.ts used pre-PR5:
//   SYSTEM_PROMPT + (pre blocks) + \n\n + retrieval.context + attachments + (post blocks)
//
// Mojo lives in POST because its `⚡ MATCHES BUYER ISO` flag conceptually annotates
// the BUYER_ISO records that came from retrieval — it reads better positioned after them.

export const PRE_RETRIEVAL_FETCHERS:  ContextFetcher[] = [
  mortgageFetcher,
  acrisFetcher,
  dobFetcher,
  calendarFetcher,
  matchesFetcher,
  liveStreetEasyFetcher,
]

export const POST_RETRIEVAL_FETCHERS: ContextFetcher[] = [
  mojoFetcher,
]

// Brief 43 PR 4 (Q4): how Drift's one-line note names a lookup that ran out of
// time (composeContext's runFetcher). Plain words: Drift may repeat them.
export const FETCHER_SOURCES = new Map<ContextFetcher, string>([
  [mortgageFetcher,       "today's mortgage rate"],
  [acrisFetcher,          'city property records'],
  [dobFetcher,            'city building records'],
  [calendarFetcher,       'the calendar'],
  [matchesFetcher,        'the new-matches list'],
  [liveStreetEasyFetcher, 'live StreetEasy'],
  [mojoFetcher,           'the CRM seller lookup'],
])

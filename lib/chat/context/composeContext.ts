import { PRE_RETRIEVAL_FETCHERS, POST_RETRIEVAL_FETCHERS } from './registry'
import type { ContextFetcher, ContextInput, ContextResult, LiveSeListing } from './types'

export interface ComposedContext {
  pre:            string              // concat of all PRE-retrieval fetcher blocks
  post:           string              // concat of all POST-retrieval fetcher blocks
  liveSeListings: LiveSeListing[]     // structured payload from liveStreetEasy fetcher
  seFilterUrl:    string | null       // structured payload from liveStreetEasy fetcher
}

async function runFetcher(f: ContextFetcher, input: ContextInput): Promise<ContextResult> {
  try {
    return await f(input)
  } catch (e) {
    console.error('[context] fetcher failed:', e instanceof Error ? e.message : e)
    return { block: null }
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
  // Run pre and post groups in parallel — per-fetcher failures isolated by runFetcher.
  const [preResults, postResults] = await Promise.all([
    Promise.all(PRE_RETRIEVAL_FETCHERS.map(f => runFetcher(f, input))),
    Promise.all(POST_RETRIEVAL_FETCHERS.map(f => runFetcher(f, input))),
  ])

  const pre  = preResults .map(r => r.block).filter((b): b is string => b !== null).join('')
  const post = postResults.map(r => r.block).filter((b): b is string => b !== null).join('')

  // Currently only liveStreetEasy populates structured fields, and it lives in PRE.
  // Check both groups for forward compatibility.
  const { liveSeListings, seFilterUrl } = collectStructured([...preResults, ...postResults])

  return { pre, post, liveSeListings, seFilterUrl }
}

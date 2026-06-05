// Phase 4.6 — Generic GET wrapper for NYC public-data endpoints (GeoSearch +
// Socrata). AbortController timeout, exponential backoff on 5xx, single 5s wait
// on 429, no retry on other 4xx. Fails SOFT: returns null rather than throwing,
// so the enrichment orchestrator can stamp an honest skip/null reason.
//
// Socrata auth is HTTP Basic using the API Key pair (NYC_SOCRATA_KEY_ID /
// NYC_SOCRATA_KEY_SECRET). GeoSearch is unauthenticated — call WITHOUT isSocrata.
// Modeled on lib/scraping/tier1Fetch.ts's AbortController pattern.

const TIMEOUT_MS = 8000

function socrataAuth(): string | undefined {
  const id = process.env.NYC_SOCRATA_KEY_ID
  const secret = process.env.NYC_SOCRATA_KEY_SECRET
  if (!id || !secret) return undefined
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64')
}

let warnedMissingAuth = false
function maybeWarnMissingAuth() {
  if (!socrataAuth() && !warnedMissingAuth) {
    console.warn('[nyc-enrich] NYC_SOCRATA_KEY_ID/SECRET not set; anonymous quota will exhaust quickly during backfill.')
    warnedMissingAuth = true
  }
}

export interface FetchOptions {
  isSocrata?: boolean
  attempts?: number
}

export async function getJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T | null> {
  const { isSocrata = false, attempts = 3 } = opts
  if (isSocrata) maybeWarnMissingAuth()

  let lastErr: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (isSocrata && socrataAuth()) headers['Authorization'] = socrataAuth()!
      const res = await fetch(url, { signal: ac.signal, headers, redirect: 'follow' })
      clearTimeout(timer)

      if (res.status === 429) {
        console.warn(`[nyc-enrich] 429 from ${url}; backing off 5s`)
        await sleep(5000)
        continue
      }
      if (res.status >= 500) {
        await sleep(300 * Math.pow(3, attempt))
        continue
      }
      if (!res.ok) {
        console.warn(`[nyc-enrich] ${res.status} from ${url}`)
        return null
      }
      return (await res.json()) as T
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      await sleep(300 * Math.pow(3, attempt))
    }
  }
  console.warn(`[nyc-enrich] all ${attempts} attempts failed for ${url}: ${(lastErr as Error)?.message}`)
  return null
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

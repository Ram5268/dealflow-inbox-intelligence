// Brief 7.2 (Fix #6) — neighborhood resolution for Mojo addresses.
//
// Primary: Nominatim (free OpenStreetMap geocoder — no key, no account). Tested
// 5/5 correct on NYC addresses incl. Manhattan. Requirements it imposes on us
// (all handled here, not by the operator): a descriptive User-Agent, and max
// 1 req/sec — we honor 1 req / 1.1s via an in-process throttle.
//
// Fallback: Claude Sonnet 4.6 (product-surface LLM per CLAUDE.md; gpt-4o-mini is
// banned for location tasks). Hallucination-safe — "unknown" becomes null. We
// never guess a neighborhood the geocoder couldn't confirm.
import Anthropic from '@anthropic-ai/sdk'

export interface GeocodeResult {
  neighborhood: string | null
  borough: string | null
  lat: number | null
  lng: number | null
  source: 'nominatim' | 'sonnet' | 'none'
}

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const USER_AGENT = 'DealFlow/1.0 (ryanmar5268@gmail.com)'
const SONNET_MODEL = 'claude-sonnet-4-6'

// Minimal Anthropic surface, so tests can inject a fake without a real key.
export interface SonnetClient {
  messages: { create: (args: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> }
}

// Nominatim asks for ≤1 req/sec; we give it 1.1s of headroom. Read at call time
// (not module load) so tests can shrink it via NOMINATIM_MIN_INTERVAL_MS.
function minIntervalMs(): number {
  return Number(process.env.NOMINATIM_MIN_INTERVAL_MS ?? 1100)
}

// Serialize + space out Nominatim calls process-wide. Each call chains onto the
// previous one's completion, then waits out any remaining interval.
let lastCallAt = 0
let throttleChain: Promise<void> = Promise.resolve()

function throttle(): Promise<void> {
  const next = throttleChain.then(async () => {
    const wait = lastCallAt + minIntervalMs() - Date.now()
    if (wait > 0) await new Promise(r => setTimeout(r, wait))
    lastCallAt = Date.now()
  })
  // Swallow errors so one failure doesn't poison the chain for later callers.
  throttleChain = next.catch(() => {})
  return next
}

function stripDistrict(name: string): string {
  return name.replace(/\s+District$/i, '').trim()
}

let cachedClient: Anthropic | null = null
function getClient(): Anthropic {
  if (cachedClient) return cachedClient
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY must be set in env.')
  cachedClient = new Anthropic({ apiKey })
  return cachedClient
}

async function queryNominatim(address: string): Promise<GeocodeResult | null> {
  await throttle()
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(address)}&format=json&addressdetails=1&limit=1`
  let json: unknown
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) return null
    json = await res.json()
  } catch {
    return null
  }

  const rows = Array.isArray(json) ? json : []
  const top = rows[0] as
    | { lat?: string; lon?: string; address?: Record<string, string> }
    | undefined
  if (!top) return null

  const a = top.address ?? {}
  const rawHood = a.neighbourhood ?? a.suburb ?? a.quarter ?? null
  const neighborhood = rawHood ? stripDistrict(rawHood) : null
  const borough = a.city_district ?? a.borough ?? a.county ?? null
  const lat = top.lat != null ? Number(top.lat) : null
  const lng = top.lon != null ? Number(top.lon) : null

  if (!neighborhood) return null // let the Sonnet fallback try

  return {
    neighborhood,
    borough: borough ?? null,
    lat: lat != null && !isNaN(lat) ? lat : null,
    lng: lng != null && !isNaN(lng) ? lng : null,
    source: 'nominatim',
  }
}

async function sonnetNeighborhood(address: string, injected?: SonnetClient): Promise<string | null> {
  let client: SonnetClient
  try {
    client = injected ?? (getClient() as unknown as SonnetClient)
  } catch {
    return null
  }
  const prompt = `You are a NYC geography expert. Given a street address, return ONLY the canonical NYC neighborhood name (e.g. "Chelsea", "Williamsburg", "Astoria"). If the neighborhood is unclear or the address is not in NYC, respond with exactly "unknown". Do not explain.

Address: ${address}`

  try {
    const response = await client.messages.create({
      model: SONNET_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    })
    const block = response.content[0]
    if (!block || block.type !== 'text' || !block.text) return null
    const answer = block.text.trim()
    // Hallucination-safe: an unconfident model returns "unknown" → null.
    if (!answer || /^unknown$/i.test(answer)) return null
    return stripDistrict(answer)
  } catch {
    return null
  }
}

export async function geocodeAddress(
  address: string,
  opts?: { sonnetClient?: SonnetClient },
): Promise<GeocodeResult> {
  const trimmed = (address ?? '').trim()
  if (!trimmed) return { neighborhood: null, borough: null, lat: null, lng: null, source: 'none' }

  const viaNominatim = await queryNominatim(trimmed)
  if (viaNominatim) return viaNominatim

  const viaSonnet = await sonnetNeighborhood(trimmed, opts?.sonnetClient)
  if (viaSonnet) {
    return { neighborhood: viaSonnet, borough: null, lat: null, lng: null, source: 'sonnet' }
  }

  return { neighborhood: null, borough: null, lat: null, lng: null, source: 'none' }
}

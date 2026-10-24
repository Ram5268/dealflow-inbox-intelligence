// FRED MORTGAGE30US — 30-year fixed rate, updates every Thursday.
// Cached in memory for 24 hours to avoid redundant API calls.
import { fetchWithTimeout } from './chat/turnBudget'

interface RateData {
  rate: number
  prevRate: number
  weekOf: string
  trend: 'up' | 'down' | 'flat'
  fetchedAt: number
}

let _cache: RateData | null = null
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export async function getCurrentMortgageRate(): Promise<RateData | null> {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) return _cache

  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) return null

  try {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=MORTGAGE30US&api_key=${apiKey}&file_type=json&limit=2&sort_order=desc`
    // Brief 43 PR 4 (M32): gives up after LOOKUP_TIMEOUT_MS [engineering precaution].
    const res = await fetchWithTimeout(url)
    if (!res.ok) throw new Error(`FRED API returned ${res.status}`)

    const data = await res.json()
    const obs: { date: string; value: string }[] = data.observations ?? []
    if (obs.length < 1) return null

    const rate = parseFloat(obs[0].value)
    const prevRate = obs.length > 1 ? parseFloat(obs[1].value) : rate
    if (isNaN(rate)) return null

    const trend: RateData['trend'] = rate > prevRate ? 'up' : rate < prevRate ? 'down' : 'flat'

    _cache = { rate, prevRate, weekOf: obs[0].date, trend, fetchedAt: Date.now() }
    return _cache
  } catch (e) {
    console.error('[MortgageRates] Failed to fetch:', (e as Error).message)
    return null
  }
}

// Brief 48 PR 13 (L2; TEST_PLAN P-06): the weekly change in basis points (a
// point of the rate is 100 of them). It was the change in points labelled
// "bps" ("down 0.10bps" for a 10-basis-point move), which Drift could repeat.
// No em-dash or arrows: Drift may quote this line.
export function formatRateContext(r: RateData): string {
  const bp = Math.round(Math.abs(r.rate - r.prevRate) * 100)
  const direction = r.trend === 'flat' || bp === 0
    ? 'unchanged from the week before'
    : `${r.trend} ${bp} basis point${bp === 1 ? '' : 's'} from ${r.prevRate.toFixed(2)}% the week before`
  return `30-year fixed mortgage rate: ${r.rate.toFixed(2)}% (week of ${r.weekOf}), ${direction}`
}

// Returns estimated monthly P&I payment for a given loan amount and rate
export function estimateMonthlyPayment(loanAmount: number, annualRatePct: number): number {
  const r = annualRatePct / 100 / 12
  const n = 360 // 30-year
  return Math.round((loanAmount * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1))
}

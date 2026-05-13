// FRED MORTGAGE30US — 30-year fixed rate, updates every Thursday.
// Cached in memory for 24 hours to avoid redundant API calls.

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
    const res = await fetch(url)
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

export function formatRateContext(r: RateData): string {
  const arrow = r.trend === 'up' ? '↑' : r.trend === 'down' ? '↓' : '→'
  const delta = Math.abs(r.rate - r.prevRate).toFixed(2)
  const direction = r.trend === 'flat' ? 'unchanged' : `${arrow} ${r.trend} ${delta}bps from ${r.prevRate.toFixed(2)}% prior week`
  return `30-year fixed mortgage rate: ${r.rate.toFixed(2)}% (week of ${r.weekOf}) — ${direction}`
}

// Returns estimated monthly P&I payment for a given loan amount and rate
export function estimateMonthlyPayment(loanAmount: number, annualRatePct: number): number {
  const r = annualRatePct / 100 / 12
  const n = 360 // 30-year
  return Math.round((loanAmount * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1))
}

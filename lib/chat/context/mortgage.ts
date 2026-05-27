import type { ContextFetcher } from './types'
import { getCurrentMortgageRate, formatRateContext, estimateMonthlyPayment } from '@/lib/mortgageRates'

// Always-on rate context. Returns null if FRED rate is unavailable.
export const mortgageFetcher: ContextFetcher = async () => {
  const rate = await getCurrentMortgageRate()
  if (!rate) return { block: null }
  const block =
    `\nMARKET RATE: ${formatRateContext(rate)}` +
    `\nAt ${rate.rate}%: $500K loan = $${estimateMonthlyPayment(500000, rate.rate).toLocaleString()}/mo` +
    ` | $1M = $${estimateMonthlyPayment(1000000, rate.rate).toLocaleString()}/mo` +
    ` | $2M = $${estimateMonthlyPayment(2000000, rate.rate).toLocaleString()}/mo`
  return { block }
}

// Brief 27.0 — "Budget reality check" section. Deterministic: median/range $/SF
// across the matched inventory vs. the buyer's number, plus the monthly carry at
// the current mortgage rate (FRED). Anti-hallucination: if no listing carries SF,
// $/SF is reported as unavailable rather than guessed.
import type { GenContext, SectionResult, SourceRef } from '../../types'
import { nowISO } from '../../types'
// Relative (not @/) so the generator chain runs under ts-node in `npm test`.
import { getCurrentMortgageRate, estimateMonthlyPayment } from '../../../../mortgageRates'
import { money, budgetCeiling } from './_format'

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

export async function budgetRealitySection(ctx: GenContext): Promise<SectionResult> {
  const b = ctx.buyer
  const matches = await ctx.matches()

  // $/SF across matched listings that carry both price and square footage.
  const ppsf = matches
    .map(m => (m.listing.price != null && m.listing.squareFeet ? m.listing.price / m.listing.squareFeet : null))
    .filter((x): x is number => x != null && Number.isFinite(x) && x > 0)
  const medianPpsf = median(ppsf)
  const minPpsf = ppsf.length ? Math.round(Math.min(...ppsf)) : null
  const maxPpsf = ppsf.length ? Math.round(Math.max(...ppsf)) : null

  const ceiling = budgetCeiling(b)
  const sources: SourceRef[] = [{ type: 'matcher', at: nowISO() }]

  const metrics: SectionResult['content']['metrics'] = []
  if (medianPpsf != null) {
    metrics.push({ label: 'Median $/SF in criteria', value: money(medianPpsf), source: 'matcher' })
    metrics.push({ label: '$/SF range', value: `${money(minPpsf)}–${money(maxPpsf)}`, source: 'matcher' })
  } else {
    metrics.push({ label: 'Median $/SF in criteria', value: 'not available (no SF on matched listings)', source: 'matcher' })
  }
  metrics.push({ label: 'Budget ceiling', value: money(ceiling), source: 'inbox' })

  // Mortgage carry at 80% LTV of the budget ceiling, at the current FRED rate.
  let rateProse = ''
  const rate = await getCurrentMortgageRate()
  if (rate && ceiling != null) {
    const loan = Math.round(ceiling * 0.8)
    const monthly = estimateMonthlyPayment(loan, rate.rate)
    metrics.push({ label: '30-yr fixed rate', value: `${rate.rate.toFixed(2)}% (week of ${rate.weekOf})`, source: 'fred' })
    metrics.push({ label: 'Est. monthly P&I', value: `${money(monthly)} on a ${money(loan)} loan (20% down)`, source: 'fred' })
    rateProse =
      ` At ${rate.rate.toFixed(2)}% (30-year fixed, week of ${rate.weekOf}), 20% down on ${money(ceiling)} ` +
      `implies roughly ${money(monthly)} a month in principal and interest before taxes and common charges.`
    sources.push({ type: 'fred', at: nowISO() })
  } else if (ceiling != null) {
    rateProse = ` Current mortgage rate is unavailable, so monthly carry is not computed here.`
  }

  const ppsfProse = medianPpsf != null
    ? `Matched inventory runs about ${money(medianPpsf)} per square foot (${money(minPpsf)}–${money(maxPpsf)}).`
    : `None of the matched listings carry square footage, so a $/SF read is not available this period.`

  const budgetProse = ceiling != null
    ? ` The buyer's ceiling is ${money(ceiling)}.`
    : ` The buyer's budget ceiling is not on file.`

  return {
    key: 'budget-reality',
    title: 'Budget reality check',
    content: { prose: ppsfProse + budgetProse + rateProse, metrics },
    sources,
  }
}

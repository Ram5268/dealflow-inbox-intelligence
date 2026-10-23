// Brief 27.0 — "Budget reality check" section. Deterministic: median/range $/SF
// across the matched inventory vs. the buyer's number, plus the monthly carry at
// the current mortgage rate (FRED). Anti-hallucination: if no listing carries SF,
// $/SF is reported as unavailable rather than guessed.
//
// Brief 48 PR 13 (M29; TEST_PLAN R-08): a renter's budget is a monthly rent, so
// a renter gets a rent read instead: the matched rentals' asking rents against
// the budget, with no mortgage maths and no $/SF (it used to say "20% down on
// $4,000 implies roughly $20 a month").
import { Category } from '@prisma/client'
import type { GenContext, MatchedListing, SectionResult, SourceRef } from '../../types'
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
  if (b.category === Category.RENTER_INQUIRY) return renterBudgetSection(ctx, matches)

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
    metrics.push({ label: 'Median $/SF in criteria', value: 'not available (no matched listing has both an asking price and SF)', source: 'matcher' })
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
    : `None of the matched listings carry both an asking price and square footage, so a $/SF read is not available this period.`

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

// A homeowner's row has no price shown, so only listings' asking rents count.
function renterBudgetSection(ctx: GenContext, matches: MatchedListing[]): SectionResult {
  const rents = matches
    .map(m => (m.listing.isHomeowner ? null : m.listing.price))
    .filter((x): x is number => x != null && Number.isFinite(x) && x > 0)
  const ceiling = budgetCeiling(ctx.buyer)
  const perMonth = (n: number | null) => `${money(n)} a month`
  const metrics: SectionResult['content']['metrics'] = []

  let prose: string
  if (rents.length > 0) {
    const mid = median(rents)
    const lo = Math.min(...rents)
    const hi = Math.max(...rents)
    prose = `Matched rentals ask a median of ${perMonth(mid)} (${money(lo)}–${money(hi)}).`
    metrics.push({ label: 'Median asking rent', value: perMonth(mid), source: 'matcher' })
    metrics.push({ label: 'Rent range', value: `${money(lo)}–${money(hi)} a month`, source: 'matcher' })
  } else {
    prose = 'None of the matched rentals carry an asking rent, so a rent read is not available this period.'
    metrics.push({ label: 'Median asking rent', value: 'not available (no matched rental has an asking rent)', source: 'matcher' })
  }
  if (ceiling != null) {
    prose += ` The renter's budget is up to ${perMonth(ceiling)}`
    if (rents.length > 0) {
      const within = rents.filter(r => r <= ceiling).length
      prose += `; ${within} of the ${rents.length} matched rental${rents.length === 1 ? '' : 's'} ${rents.length === 1 ? 'is' : 'are'} within it`
      metrics.push({ label: 'Within budget', value: `${within} of ${rents.length}`, source: 'matcher' })
    }
    prose += '.'
    metrics.push({ label: 'Budget ceiling', value: perMonth(ceiling), source: 'inbox' })
  } else {
    prose += ` The renter's budget is not on file.`
  }

  return {
    key: 'budget-reality',
    title: 'Budget reality check',
    content: { prose, metrics },
    sources: [{ type: 'matcher', at: nowISO() }],
  }
}

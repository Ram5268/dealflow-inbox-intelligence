// Brief 27.0 — "Matching inventory" section. Deterministic: counts the matcher's
// output by tier. Curated = HOT; near-miss = WARM/POSSIBLE.
import type { GenContext, SectionResult } from '../../types'
import { nowISO } from '../../types'
import { criteriaLine } from './_format'

export async function matchingInventorySection(ctx: GenContext): Promise<SectionResult> {
  const matches = await ctx.matches()
  const hot = matches.filter(m => m.tier === 'HOT').length
  const warm = matches.filter(m => m.tier === 'WARM').length
  const possible = matches.filter(m => m.tier === 'POSSIBLE').length
  const total = matches.length

  const prose = total === 0
    ? `No inventory currently matches the criteria (${criteriaLine(ctx.buyer)}). Nothing has tiered against this buyer yet.`
    : `${total} listing${total === 1 ? '' : 's'} tier against the criteria right now: ` +
      `${hot} clear fit${hot === 1 ? '' : 's'}, ${warm} warm, and ${possible} possible.`

  const metrics = [
    { label: 'Matches this period', value: String(total), source: 'matcher' },
    { label: 'Clear fits (HOT)', value: String(hot), source: 'matcher' },
    { label: 'Warm', value: String(warm), source: 'matcher' },
    { label: 'Possible', value: String(possible), source: 'matcher' },
  ]

  return {
    key: 'matching-inventory',
    title: 'Matching inventory',
    content: { prose, metrics },
    sources: [{ type: 'matcher', at: nowISO() }],
  }
}

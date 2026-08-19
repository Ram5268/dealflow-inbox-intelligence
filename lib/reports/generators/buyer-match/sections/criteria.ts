// Brief 27.0 — "Criteria of record" section. Deterministic: reads the buyer's
// ExtractedOpportunity criteria fields and restates them. No matches needed.
import type { GenContext, SectionResult } from '../../types'
import { nowISO } from '../../types'
import { criteriaLine, priceRange, bedsLabel } from './_format'

export async function criteriaSection(ctx: GenContext): Promise<SectionResult> {
  const b = ctx.buyer
  const hood = b.neighborhoods.length ? b.neighborhoods.join(', ') : b.borough ?? 'not on file'

  const prose =
    `${b.name} is looking in ${hood} for ${bedsLabel(b.minBeds, b.maxBeds, b.beds)} ` +
    `at ${priceRange(b.minPrice, b.maxPrice)}.` +
    (b.propertyTypes.length ? ` Property type: ${b.propertyTypes.join(', ')}.` : '') +
    (b.mustHaves ? ` Must-haves: ${b.mustHaves}.` : '') +
    (b.dealbreakers ? ` Dealbreakers: ${b.dealbreakers}.` : '') +
    (b.timeline ? ` Timeline: ${b.timeline}.` : '')

  const metrics = [
    { label: 'Location', value: hood, source: 'inbox' },
    { label: 'Beds', value: bedsLabel(b.minBeds, b.maxBeds, b.beds), source: 'inbox' },
    { label: 'Budget', value: priceRange(b.minPrice, b.maxPrice), source: 'inbox' },
    { label: 'Summary', value: criteriaLine(b), source: 'inbox' },
  ]

  return {
    key: 'criteria',
    title: 'Criteria of record',
    content: { prose, metrics },
    sources: [{ type: 'inbox', id: b.id, at: nowISO() }],
  }
}

// Brief 27.0 — "Near misses" section. Deterministic: the WARM/POSSIBLE-tier
// listings from the matcher — close but not clear fits. The matcher's stored
// reason explains why each fell short, which is where criteria get revised.
import type { GenContext, SectionResult, SourceRef } from '../../types'
import { nowISO } from '../../types'
import { money, bedsLabel } from './_format'

const NEAR_MISS_LIMIT = 8

export async function nearMissesSection(ctx: GenContext): Promise<SectionResult> {
  const matches = await ctx.matches()
  const near = matches
    .filter(m => m.tier === 'WARM' || m.tier === 'POSSIBLE')
    .slice(0, NEAR_MISS_LIMIT)

  const items = near.map(m => ({
    listingId: m.listing.id,
    address: m.listing.address ?? m.listing.extractedTitle,
    neighborhood: m.listing.neighborhood ?? 'not on file',
    price: m.listing.price,
    priceLabel: money(m.listing.price),
    beds: m.listing.beds,
    bedsLabel: bedsLabel(null, null, m.listing.beds),
    tier: m.tier,
    why: m.reason ?? 'Tiered below a clear fit by the matcher.',
    source: m.listing.sourceBrokerage ?? m.listing.sourceAgentName ?? 'inbox',
  }))

  const prose = items.length === 0
    ? 'No near-misses this period. Nothing tiered as warm or possible against the criteria.'
    : `${items.length} near-miss${items.length === 1 ? '' : 'es'} worth a look: ` +
      items.map(i => `${i.address} at ${i.priceLabel} (${i.why})`).join('; ') + '.'

  const sources: SourceRef[] = [
    { type: 'matcher', at: nowISO() },
    ...near.map(m => ({ type: 'inbox' as const, id: m.listing.id, at: nowISO() })),
  ]

  return {
    key: 'near-misses',
    title: 'Near misses',
    content: { prose, items },
    sources,
  }
}

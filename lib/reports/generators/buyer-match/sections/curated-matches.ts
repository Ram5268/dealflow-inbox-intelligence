// Brief 27.0 — "Curated matches" section. Deterministic: the HOT-tier listings
// from the matcher, each with its fit rationale (the matcher's stored reason).
import type { GenContext, SectionResult, SourceRef, MatchedListing } from '../../types'
import { nowISO } from '../../types'
import { money, bedsLabel } from './_format'
import { plainFitReason } from '../../../../matching/fitReason'

// Brief 41 (H7): a homeowner has no asking price (our estimate never shows) and
// is never named; its fit line never mentions the seller's circumstances.
export const HOMEOWNER_PRICE_LABEL = 'off-market, price not set'
export function priceOf(m: MatchedListing): { price: number | null; priceLabel: string } {
  return m.listing.isHomeowner
    ? { price: null, priceLabel: HOMEOWNER_PRICE_LABEL }
    : { price: m.listing.price, priceLabel: money(m.listing.price) }
}
export function sourceOf(m: MatchedListing): string {
  return m.listing.isHomeowner ? 'off-market seller' : m.listing.sourceBrokerage ?? m.listing.sourceAgentName ?? 'inbox'
}

const CURATED_LIMIT = 8

export async function curatedMatchesSection(ctx: GenContext): Promise<SectionResult> {
  const matches = await ctx.matches()
  const hot = matches.filter(m => m.tier === 'HOT').slice(0, CURATED_LIMIT)

  const items = hot.map(m => ({
    listingId: m.listing.id,
    address: m.listing.address ?? m.listing.extractedTitle,
    neighborhood: m.listing.neighborhood ?? 'not on file',
    ...priceOf(m),
    beds: m.listing.beds,
    bedsLabel: bedsLabel(null, null, m.listing.beds),
    tier: m.tier,
    fit: m.reason ? plainFitReason(m.reason, { homeowner: m.listing.isHomeowner }) : 'Tiered as a strong fit by the matcher.',
    source: sourceOf(m),
  }))

  const prose = items.length === 0
    ? 'No clear fits to curate this period. See near-misses for what came close.'
    : `${items.length} clear fit${items.length === 1 ? '' : 's'} worth a showing: ` +
      items.map(i => (i.price == null && i.priceLabel === HOMEOWNER_PRICE_LABEL ? `${i.address} (${i.priceLabel})` : `${i.address} at ${i.priceLabel}`)).join('; ') + '.'

  const sources: SourceRef[] = [
    { type: 'matcher', at: nowISO() },
    ...hot.map(m => ({ type: 'inbox' as const, id: m.listing.id, at: nowISO() })),
  ]

  return {
    key: 'curated-matches',
    title: 'Curated matches',
    content: { prose, items },
    sources,
  }
}

// Exposed for the near-miss section, which shares the tier-filter shape.
export function toItem(m: MatchedListing) {
  return {
    listingId: m.listing.id,
    address: m.listing.address ?? m.listing.extractedTitle,
    neighborhood: m.listing.neighborhood ?? 'not on file',
    ...priceOf(m),
    tier: m.tier,
    reason: m.reason ? plainFitReason(m.reason, { homeowner: m.listing.isHomeowner }) : '',
  }
}

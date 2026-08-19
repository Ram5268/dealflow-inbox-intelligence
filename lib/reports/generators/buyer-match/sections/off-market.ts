// Brief 27.0 — "Off-market and pre-market" section. Deterministic: query the
// inbox for pre-market / off-market supply in the buyer's neighborhoods —
// whisper listings and expected launches the on-market match pool misses.
import { Category } from '@prisma/client'
import type { GenContext, SectionResult, SourceRef } from '../../types'
import { nowISO } from '../../types'
import { money, bedsLabel } from './_format'

const PREMARKET_SALE: Category[] = [
  Category.COMING_SOON_SALE,
  Category.OFF_MARKET_SALE,
  Category.COMING_SOON_DEVELOPMENT,
  Category.SPONSOR_UNIT,
  Category.DEVELOPMENT_INVENTORY,
]
const PREMARKET_RENTAL: Category[] = [Category.COMING_SOON_RENTAL]

const OFF_MARKET_LIMIT = 8

export async function offMarketSection(ctx: GenContext): Promise<SectionResult> {
  const b = ctx.buyer
  const cats = b.category === Category.RENTER_INQUIRY ? PREMARKET_RENTAL : PREMARKET_SALE

  const rows = await ctx.prisma.extractedOpportunity.findMany({
    where: {
      category: { in: cats },
      isTestData: b.isTestData,
      isDuplicate: false,
      processingStatus: 'active',
      ...(b.neighborhoods.length
        ? { OR: [{ neighborhood: { in: b.neighborhoods } }, { neighborhoods: { hasSome: b.neighborhoods } }] }
        : {}),
    },
    select: {
      id: true, category: true, address: true, neighborhood: true, price: true, beds: true,
      extractedTitle: true, availabilityDate: true, sourceBrokerage: true, sourceAgentName: true,
    },
    orderBy: { createdAt: 'desc' },
    take: OFF_MARKET_LIMIT,
  })

  const items = rows.map(r => ({
    listingId: r.id,
    category: r.category,
    address: r.address ?? r.extractedTitle,
    neighborhood: r.neighborhood ?? 'not on file',
    price: r.price,
    priceLabel: money(r.price),
    bedsLabel: bedsLabel(null, null, r.beds),
    expected: r.availabilityDate ?? 'timing not on file',
    source: r.sourceBrokerage ?? r.sourceAgentName ?? 'inbox',
  }))

  const prose = items.length === 0
    ? `No pre-market or off-market inventory on file in ${b.neighborhoods.join(', ') || 'the buyer\'s area'} right now.`
    : `${items.length} pre-market / off-market lead${items.length === 1 ? '' : 's'} in the buyer's area: ` +
      items.map(i => `${i.address} (${i.category.replace(/_/g, ' ').toLowerCase()}, ${i.priceLabel})`).join('; ') + '.'

  const sources: SourceRef[] = [
    ...rows.map(r => ({ type: 'inbox' as const, id: r.id, at: nowISO() })),
  ]
  if (sources.length === 0) sources.push({ type: 'inbox', at: nowISO() })

  return {
    key: 'off-market',
    title: 'Off-market and pre-market',
    content: { prose, items },
    sources,
  }
}

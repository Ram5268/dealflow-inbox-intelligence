import type { ContextFetcher } from './types'
import { buildStreetEasyFilterUrl } from '@/lib/chat/streetEasyUrls'

// Triggered when Ryan has a buyer/rental intent + at least one neighborhood.
// Returns both an LLM-facing context block AND structured payloads (liveSeListings + seFilterUrl)
// that route.ts forwards in the JSON response so the UI can render live SE cards.
export const liveStreetEasyFetcher: ContextFetcher = async ({ parsed }) => {
  const isRentalIntent = parsed.categories.some(c =>
    ['RENTAL_LISTING','COMING_SOON_RENTAL','RENTER_INQUIRY'].includes(c)
  )
  const shouldSearch = (parsed.isMyBuyer || isRentalIntent) && parsed.neighborhoods.length > 0
  if (!shouldSearch) return { block: null }

  const lowerHoods = parsed.neighborhoods.map(n => n.toLowerCase())
  const seFilterUrl = buildStreetEasyFilterUrl({
    neighborhoods: lowerHoods,
    minBeds:  parsed.minBeds,
    maxBeds:  parsed.maxBeds,
    minPrice: parsed.minPrice,
    maxPrice: parsed.maxPrice,
    minUnits: parsed.minUnits,
    maxUnits: parsed.maxUnits,
    isRental: isRentalIntent,
  })

  try {
    // Dynamic import — same pattern as the pre-PR5 inline code
    const { searchStreetEasyListings } = await import('@/lib/streetEasySync')
    const liveSeListings = await searchStreetEasyListings({
      neighborhoods: lowerHoods,
      minBeds:  parsed.minBeds,
      maxBeds:  parsed.maxBeds,
      minPrice: parsed.minPrice,
      maxPrice: parsed.maxPrice,
      isRental: isRentalIntent,
      limit:    50,
    })
    console.log('[SE search] liveSeListings:', liveSeListings.length)

    const listingLines = liveSeListings.map(l =>
      `- $${l.price?.toLocaleString() ?? 'TBD'} | ${l.url}`
    ).join('\n')

    const block =
      `\n\nLIVE STREETEASY LISTINGS (active on market, filtered to exact criteria):\n` +
      (liveSeListings.length > 0 ? listingLines : '(no matching listings found in your database for this query)') +
      (seFilterUrl ? `\n\nBrowse all matching listings on StreetEasy: ${seFilterUrl}` : '')

    return { block, liveSeListings, seFilterUrl, streetEasySearches: 1 }
  } catch (err) {
    console.error('[SE search] error:', err)
    return {
      block: seFilterUrl ? `\n\nBrowse matching listings on StreetEasy: ${seFilterUrl}` : null,
      liveSeListings: [],
      seFilterUrl,
      streetEasySearches: 1, // Brief 43 PR 15: counted even when it failed or timed out
    }
  }
}

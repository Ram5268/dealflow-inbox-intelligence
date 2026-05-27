// StreetEasy URL utilities — pure functions, no I/O.
// Migrated in Phase B: HOOD_TO_BOROUGH and the inline seAreaMap are now
// derived from lib/domain/Neighborhood instead of hand-maintained here.

import { fromRaw, getBorough, getStreetEasySlug } from '../domain/Neighborhood'

// Convert a NYC borough name to the slug StreetEasy uses in URLs.
// SE quirk: Manhattan is "new-york" in URLs, not "manhattan".
function boroughToSlug(borough: ReturnType<typeof getBorough>): string {
  if (!borough) return 'new-york'
  if (borough === 'Manhattan') return 'new-york'
  return borough.toLowerCase().replace(/\s+/g, '-')
}

export function buildStreetEasyBuildingUrl(
  address: string,
  neighborhood: string | null,
): string {
  // Strip unit designator — building page slug is street address only
  // e.g. "109 Devoe Street GARDEN-2" → "109-devoe-street-brooklyn"
  const STREET_TYPES = /\b(street|avenue|boulevard|road|drive|place|court|lane|terrace|circle|parkway|highway|st|ave|blvd|rd|dr|pl|ct|ln|ter|pkwy)\b\.?/gi
  const typeMatches = [...address.matchAll(STREET_TYPES)]

  let streetPart = address
  if (typeMatches.length > 0) {
    const last = typeMatches[typeMatches.length - 1]
    // Keep everything up to and including the street type suffix, drop the unit
    streetPart = address.slice(0, (last.index ?? 0) + last[0].length).trim()
  }

  const canonical = fromRaw(neighborhood)
  const borough   = canonical ? getBorough(canonical) : null
  const boroughSlug = boroughToSlug(borough)
  const slug = streetPart.toLowerCase()
    .replace(/[.']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

  return `https://www.streeteasy.com/building/${slug}-${boroughSlug}`
}

// Build a properly filtered StreetEasy search URL using their native filter format:
// https://streeteasy.com/for-sale/williamsburg/price:-1500000|beds:2?sort_by=se_score
export function buildStreetEasyFilterUrl(params: {
  neighborhoods: string[]
  minBeds?:  number | null
  maxBeds?:  number | null
  minPrice?: number | null
  maxPrice?: number | null
  isRental?: boolean
}): string | null {
  const { neighborhoods, minBeds, maxBeds, minPrice, maxPrice, isRental = false } = params
  // Find the first neighborhood that maps to a StreetEasy area slug.
  // Slug source is lib/domain/Neighborhood.streetEasySlug (Phase B canonical map).
  const area = neighborhoods
    .map(n => {
      const canonical = fromRaw(n)
      return canonical ? getStreetEasySlug(canonical) : null
    })
    .find((slug): slug is string => !!slug)
  if (!area) return null

  const type = isRental ? 'for-rent' : 'for-sale'
  const filters: string[] = []

  if (minPrice && maxPrice) filters.push(`price:${minPrice}-${maxPrice}`)
  else if (maxPrice)         filters.push(`price:-${maxPrice}`)
  else if (minPrice)         filters.push(`price:${minPrice}-`)

  if (minBeds != null && maxBeds != null && minBeds !== maxBeds) filters.push(`beds:${minBeds}-${maxBeds}`)
  else if (minBeds != null)  filters.push(`beds:${minBeds}`)
  else if (maxBeds != null)  filters.push(`beds:${maxBeds}`)

  const filterPath = filters.length > 0 ? `/${filters.join('|')}` : ''
  return `https://streeteasy.com/${type}/${area}${filterPath}?sort_by=se_score`
}

// Only returns a URL when we have a real direct listing link (streetEasyId from API sync
// or a URL embedded in the email body). Never returns search/fallback URLs — those
// mislead the user by showing unfiltered results.
export function getStreetEasyUrl(
  streetEasyId: string | null | undefined,
  category: string,
  bodyContent?: string | null,
  attachmentsText?: string | null,
): string | null {
  if (streetEasyId) {
    if (streetEasyId.includes('/')) return `https://www.streeteasy.com/${streetEasyId}`
    const isRental = ['RENTAL_LISTING', 'COMING_SOON_RENTAL'].includes(category)
    return `https://www.streeteasy.com/${isRental ? 'rental' : 'sale'}/${streetEasyId}`
  }
  const text = (bodyContent ?? '') + (attachmentsText ?? '')
  const m = text.match(/https?:\/\/(?:www\.)?streeteasy\.com\/[^\s"'<>)\]]+/i)
  if (m) return m[0].replace(/[,\.!?]+$/, '')
  return null
}

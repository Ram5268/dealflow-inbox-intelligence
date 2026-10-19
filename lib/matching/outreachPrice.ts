// Our estimated home values are internal only and never go into outreach. A seller
// contact (homeowner) has no asking price: its supply price is null and our estimate
// isn't carried on supply at all (supplyResolver.ts, Brief 41), so an outreach draft
// says "price on request" for one. Listings from email keep their asking price.
// Brief 43 PR 3b: the Buyer Match report's homeowner rows read the same words.
import { formatPriceRange } from '../utils'
import type { ResolvedSupply } from './supplyResolver'

export const PRICE_ON_REQUEST = 'price on request'

export function outreachPriceText(supply: Pick<ResolvedSupply, 'opportunityType' | 'minPrice' | 'maxPrice' | 'price'>): string {
  if (supply.opportunityType === 'contact') return PRICE_ON_REQUEST
  return formatPriceRange(supply.minPrice, supply.maxPrice, supply.price) || PRICE_ON_REQUEST
}

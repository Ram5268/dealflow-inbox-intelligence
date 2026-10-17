// Our estimated home values are internal only and never go into outreach. A seller
// contact (homeowner) has no asking price: its supply price is null and our estimate
// isn't carried on supply at all (supplyResolver.ts, Brief 41), so an outreach draft
// says "price on request" for one. Listings from email keep their asking price.
import { formatPriceRange } from '../utils'
import type { ResolvedSupply } from './supplyResolver'

export function outreachPriceText(supply: Pick<ResolvedSupply, 'opportunityType' | 'minPrice' | 'maxPrice' | 'price'>): string {
  if (supply.opportunityType === 'contact') return 'price on request'
  return formatPriceRange(supply.minPrice, supply.maxPrice, supply.price) || 'price on request'
}

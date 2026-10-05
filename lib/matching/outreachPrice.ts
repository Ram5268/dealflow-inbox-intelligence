// Our estimated home values are internal only and never go into outreach. A seller
// contact's supply "price" is our estimate (supplyResolver.ts), so an outreach draft
// never quotes a price for one. Listings from email keep their asking price.
import { formatPriceRange } from '../utils'
import type { ResolvedSupply } from './supplyResolver'

export function outreachPriceText(supply: Pick<ResolvedSupply, 'opportunityType' | 'minPrice' | 'maxPrice' | 'price'>): string {
  if (supply.opportunityType === 'contact') return 'price on request'
  return formatPriceRange(supply.minPrice, supply.maxPrice, supply.price) || 'price on request'
}

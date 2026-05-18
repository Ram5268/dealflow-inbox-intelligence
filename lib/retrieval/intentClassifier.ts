import type { IntentBucket } from './types'

interface ClassifyInput {
  raw:           string
  neighborhoods: string[]
  boroughs:      string[]
  categories:    string[]
  isCalendar:    boolean
  isACRIS:       boolean
  isDOB:         boolean
}

const DEMAND_CATS    = new Set(['BUYER_ISO','RENTER_INQUIRY'])
const LEAD_CATS      = new Set(['SELLER_LEAD','LANDLORD_LEAD'])
const SUPPLY_CATS    = new Set([
  'ACTIVE_SALE_LISTING','RENTAL_LISTING','COMING_SOON_SALE','COMING_SOON_RENTAL',
  'OFF_MARKET_SALE','BACK_ON_MARKET','PRICE_DROP','OPEN_HOUSE',
  'DEVELOPMENT_INVENTORY','SPONSOR_UNIT','SHOWING_CONFIRMATION',
])

export function classifyIntent(input: ClassifyInput): IntentBucket {
  const { raw, categories, isCalendar, isACRIS, isDOB } = input
  const lower = raw.toLowerCase()

  // Calendar wins immediately
  if (isCalendar && /\b(schedule|book|set up|add to calendar|block)\b/.test(lower)) {
    return 'calendar_scheduling'
  }

  // Property intelligence (ACRIS/DOB)
  if (isACRIS || isDOB) return 'property_intelligence'

  // Explicit category signals
  const hasDemand  = categories.some(c => DEMAND_CATS.has(c))
  const hasLead    = categories.some(c => LEAD_CATS.has(c))
  const hasSupply  = categories.some(c => SUPPLY_CATS.has(c))

  // Market question
  if (/\b(market report|market update|average price|price trend|inventory|absorption|market|how is the market|what.s the market)\b/.test(lower)) {
    return 'market_question'
  }

  // Match review — "my buyer", "my client", "my investor", "what fits", "anything for"
  if (/\b(my buyer|my client|my investor|my renter|for my|what fits|anything for|good for|works for|match|matches)\b/.test(lower)) {
    return 'match_review'
  }

  // Demand search
  if (hasDemand || /\b(buyer iso|iso|buyer looking|renter looking|renter inquiry|seeking|wants to buy|needs an apartment)\b/.test(lower)) {
    return 'demand_search'
  }

  // Seller/landlord lead search
  if (hasLead || /\b(seller lead|landlord lead|potential seller|who wants to sell|listing lead|owner)\b/.test(lower)) {
    return 'seller_lead_search'
  }

  // Supply-side opportunity search (explicit categories OR rental/sale keywords + location)
  if (hasSupply || /\b(listing|listings|rental|rentals|for rent|for sale|available|on market|just listed|open house|coming soon|off.?market)\b/.test(lower)) {
    return 'opportunity_search'
  }

  // If there are neighborhoods/boroughs, likely an opportunity search
  if (input.neighborhoods.length > 0 || input.boroughs.length > 0) {
    return 'opportunity_search'
  }

  return 'general'
}

import type { ParsedQuery, QueryPlan, IntentBucket } from './types'

// ── Adjacent neighborhood map (expand search to nearby neighborhoods) ─────────
const ADJACENT: Record<string, string[]> = {
  'Williamsburg':       ['Greenpoint','Bushwick','Bed-Stuy'],
  'Greenpoint':         ['Williamsburg','Long Island City','Astoria'],
  'Bushwick':           ['Williamsburg','Ridgewood','Bed-Stuy','Crown Heights'],
  'Bed-Stuy':           ['Crown Heights','Bushwick','Clinton Hill','Stuyvesant Heights'],
  'Crown Heights':      ['Bed-Stuy','Prospect Heights','Flatbush','Prospect Lefferts Gardens'],
  'Park Slope':         ['Carroll Gardens','Gowanus','Windsor Terrace','Prospect Heights'],
  'Carroll Gardens':    ['Cobble Hill','Boerum Hill','Red Hook','Park Slope','Gowanus'],
  'Cobble Hill':        ['Carroll Gardens','Boerum Hill','Brooklyn Heights'],
  'Boerum Hill':        ['Cobble Hill','Carroll Gardens','Park Slope','Fort Greene'],
  'Brooklyn Heights':   ['Cobble Hill','DUMBO','Downtown Brooklyn'],
  'DUMBO':              ['Brooklyn Heights','Fort Greene','Vinegar Hill'],
  'Fort Greene':        ['Clinton Hill','Boerum Hill','DUMBO'],
  'Clinton Hill':       ['Fort Greene','Bed-Stuy','Prospect Heights'],
  'Prospect Heights':   ['Crown Heights','Park Slope','Fort Greene','Clinton Hill'],
  'Tribeca':            ['SoHo','Financial District','Battery Park City','Hudson Square'],
  'SoHo':               ['Tribeca','NoHo','Nolita','West Village'],
  'NoHo':               ['SoHo','East Village','Greenwich Village'],
  'Nolita':             ['SoHo','NoHo','Little Italy','Lower East Side'],
  'West Village':       ['Greenwich Village','Chelsea','SoHo'],
  'Greenwich Village':  ['West Village','NoHo','East Village','Chelsea'],
  'East Village':       ['Lower East Side','NoHo','Greenwich Village'],
  'Lower East Side':    ['East Village','Nolita','Two Bridges'],
  'Chelsea':            ["Hell's Kitchen","West Village","Flatiron","Hudson Yards"],
  'Flatiron':           ['Chelsea','Gramercy','NoMad','Murray Hill'],
  'NoMad':              ['Flatiron','Murray Hill','Kips Bay','Gramercy'],
  'Gramercy':           ['Flatiron','NoMad','Murray Hill','Stuyvesant Town'],
  'Murray Hill':        ['Gramercy','NoMad','Kips Bay','Midtown East'],
  "Hell's Kitchen":     ['Chelsea','Midtown West','Clinton'],
  'Midtown West':       ["Hell's Kitchen",'Midtown'],
  'Midtown East':       ['Murray Hill','Midtown','Upper East Side'],
  'Upper West Side':    ['Morningside Heights','Harlem','Midtown West'],
  'Upper East Side':    ['Lenox Hill','Yorkville','Carnegie Hill','Midtown East'],
  'Long Island City':   ['Astoria','Greenpoint','Sunnyside'],
  'Astoria':            ['Long Island City','Sunnyside','Woodside','Greenpoint'],
}

// ── Category sets by intent ───────────────────────────────────────────────────
const SUPPLY_ALL = [
  'ACTIVE_SALE_LISTING','RENTAL_LISTING','COMING_SOON_SALE','COMING_SOON_RENTAL',
  'OFF_MARKET_SALE','BACK_ON_MARKET','PRICE_DROP','OPEN_HOUSE',
  'DEVELOPMENT_INVENTORY','COMING_SOON_DEVELOPMENT','SPONSOR_UNIT',
]
const SUPPLY_SALE   = ['ACTIVE_SALE_LISTING','OFF_MARKET_SALE','COMING_SOON_SALE','BACK_ON_MARKET','PRICE_DROP','DEVELOPMENT_INVENTORY','COMING_SOON_DEVELOPMENT','SPONSOR_UNIT']
const SUPPLY_RENTAL = ['RENTAL_LISTING','COMING_SOON_RENTAL']
const DEMAND_ALL    = ['BUYER_ISO','RENTER_INQUIRY']
const LEAD_ALL      = ['SELLER_LEAD','LANDLORD_LEAD']

function categoriesForIntent(intent: IntentBucket, parsed: ParsedQuery): string[] {
  // If the query explicitly named categories, use those
  if (parsed.categories.length > 0) return parsed.categories

  switch (intent) {
    case 'opportunity_search':
      if (parsed.isRental === true)  return SUPPLY_RENTAL
      if (parsed.isRental === false) return SUPPLY_SALE
      return SUPPLY_ALL
    case 'demand_search':
      return DEMAND_ALL
    case 'seller_lead_search':
      return LEAD_ALL
    case 'match_review':
      // Match review: search supply-side to match against demand criteria
      if (parsed.isRental === true)  return SUPPLY_RENTAL
      if (parsed.isRental === false) return SUPPLY_SALE
      return SUPPLY_ALL
    case 'property_intelligence':
      return []   // no opportunity search, just tools
    case 'market_question':
      return ['MARKET_REPORT','REAL_ESTATE_EVENT']
    case 'calendar_scheduling':
      return ['SHOWING_CONFIRMATION']
    case 'general':
    default:
      return [...SUPPLY_ALL, ...DEMAND_ALL]
  }
}

function toolsForIntent(intent: IntentBucket, isACRIS: boolean, isDOB: boolean, isCalendar: boolean): QueryPlan['tools'] {
  const tools: QueryPlan['tools'] = ['structured_retrieval', 'vector_search']
  if (isACRIS)   tools.push('acris')
  if (isDOB)     tools.push('dob')
  if (isCalendar) tools.push('calendar')
  if (intent === 'property_intelligence') return tools.filter(t => t === 'acris' || t === 'dob')
  if (intent === 'calendar_scheduling')   return ['calendar','structured_retrieval']
  return tools
}

function freshnessWindow(intent: IntentBucket): number {
  switch (intent) {
    case 'opportunity_search': return 90   // listings from last 90 days
    case 'demand_search':      return 60   // buyer/renter ISOs from last 60 days
    case 'seller_lead_search': return 180  // leads can be older
    case 'match_review':       return 90
    case 'calendar_scheduling':return 30
    case 'market_question':    return 365  // reports can be older
    default:                   return 90
  }
}

export function buildQueryPlan(parsed: ParsedQuery): QueryPlan {
  const searchCategories = categoriesForIntent(parsed.intent, parsed)

  // Build adjacent neighborhood expansion
  const adjacentMap: Record<string, string[]> = {}
  for (const n of parsed.neighborhoods) {
    const adj = ADJACENT[n]
    if (adj) adjacentMap[n] = adj
  }

  return {
    intent:             parsed.intent,
    searchCategories,
    excludeCategories:  ['NOISE'],
    includeReviewQueue: false,
    filters: {
      neighborhoods:       parsed.neighborhoods,
      boroughs:            parsed.boroughs,
      minBeds:             parsed.minBeds ?? (parsed.beds !== null ? parsed.beds : null),
      maxBeds:             parsed.maxBeds ?? (parsed.beds !== null ? parsed.beds : null),
      minPrice:            parsed.minPrice,
      maxPrice:            parsed.maxPrice,
      freshnessWindowDays: freshnessWindow(parsed.intent),
    },
    adjacentNeighborhoods: adjacentMap,
    tools: toolsForIntent(parsed.intent, parsed.isACRIS, parsed.isDOB, parsed.isCalendar),
  }
}

import type { ParsedQuery, QueryPlan, IntentBucket } from './types'
import {
  NEIGHBORHOODS,
  fromRaw,
  getAdjacent,
} from '../domain/Neighborhood'
import {
  SUPPLY_SALE,
  SUPPLY_RENTAL,
  DEMAND_BUYER,
  DEMAND_RENTER,
  LEAD_SELLER,
  LEAD_LANDLORD,
} from '../domain/Categories'
import { reconcileIntent } from './reconcile'

// ── Category sets by intent ───────────────────────────────────────────────────
// SUPPLY_RENTAL / DEMAND_ALL / LEAD_ALL / SALE_CATS_FOR_FILTER / RENTAL_CATS_FOR_FILTER
// were local copies until Phase B. Now sourced from lib/domain/Categories so they
// stay in sync with the Prisma enum exhaustiveness check there.

const SUPPLY_ALL: readonly string[] = [...SUPPLY_SALE, ...SUPPLY_RENTAL, 'OPEN_HOUSE']
// Active on-market sale listings — default for buyer searches with no coming-soon intent.
// Local to queryPlanner: lib/domain has SUPPLY_SALE (all of them) but not this on-market subset.
const SUPPLY_SALE_ACTIVE: readonly string[] = ['ACTIVE_SALE_LISTING', 'BACK_ON_MARKET', 'PRICE_DROP', 'DEVELOPMENT_INVENTORY', 'SPONSOR_UNIT']
// Pre-market only — returned when "coming soon" or "off market" is explicitly requested.
// Local to queryPlanner for the same reason.
const SUPPLY_SALE_PREMARKET: readonly string[] = ['COMING_SOON_SALE', 'OFF_MARKET_SALE', 'COMING_SOON_DEVELOPMENT']
const DEMAND_ALL: readonly string[] = [...DEMAND_BUYER, ...DEMAND_RENTER]
const LEAD_ALL: readonly string[]   = [...LEAD_SELLER, ...LEAD_LANDLORD]

// Pre-market keywords that expand to the full pre-market set when seen with a buyer intent.
const PREMARKET_CATS = new Set<string>(['COMING_SOON_SALE', 'OFF_MARKET_SALE', 'COMING_SOON_DEVELOPMENT', 'COMING_SOON_RENTAL'])

// `reconciledCategories` is the output of reconcileIntent() — sale/rental
// conflicts with the deterministic isRental flag have already been resolved
// upstream. The intent-routing sanitization below only handles intent-level
// filters (drop demand on supply intents, drop rentals on buyer intent).
function categoriesForIntent(
  intent:               IntentBucket,
  parsed:               ParsedQuery,
  reconciledCategories: readonly string[],
): readonly string[] {
  const isSupplyIntent = intent === 'opportunity_search' || intent === 'match_review'
  const isBuyerIntent  = isSupplyIntent && parsed.isRental === false

  const sanitized = isSupplyIntent
    ? reconciledCategories.filter(c => {
        if (DEMAND_ALL.includes(c)) return false
        if (isBuyerIntent && (c === 'COMING_SOON_RENTAL' || c === 'RENTAL_LISTING')) return false
        return true
      })
    : reconciledCategories

  if (sanitized.length > 0) {
    // If any pre-market keyword was detected in a buyer query, return the full pre-market set
    // (COMING_SOON_SALE, OFF_MARKET_SALE, COMING_SOON_DEVELOPMENT are synonymous to the user)
    if (isBuyerIntent && sanitized.some(c => PREMARKET_CATS.has(c))) return SUPPLY_SALE_PREMARKET
    return sanitized
  }

  switch (intent) {
    case 'opportunity_search':
      if (parsed.isRental === true)  return SUPPLY_RENTAL
      if (parsed.isRental === false) return SUPPLY_SALE_ACTIVE  // active listings only by default
      return SUPPLY_ALL
    case 'demand_search':
      return DEMAND_ALL
    case 'seller_lead_search':
      return LEAD_ALL
    case 'match_review':
      if (parsed.isRental === true)  return SUPPLY_RENTAL
      if (parsed.isRental === false) return SUPPLY_SALE_ACTIVE  // active listings only by default
      return SUPPLY_ALL
    case 'property_intelligence':
      return []
    case 'market_question':
      return ['MARKET_REPORT', 'REAL_ESTATE_EVENT']
    case 'calendar_scheduling':
      return ['SHOWING_CONFIRMATION']
    case 'general':
    default:
      // DEALFLOW_AI rule: BUYER_ISO + RENTER_INQUIRY are NEVER shown for general queries.
      // They're demand records, not inventory — only surface when explicitly requested.
      return SUPPLY_ALL
  }
}

function toolsForIntent(intent: IntentBucket, isACRIS: boolean, isDOB: boolean, isCalendar: boolean): QueryPlan['tools'] {
  const tools: QueryPlan['tools'] = ['structured_retrieval', 'vector_search']
  if (isACRIS)    tools.push('acris')
  if (isDOB)      tools.push('dob')
  if (isCalendar) tools.push('calendar')
  if (intent === 'property_intelligence') return tools.filter(t => t === 'acris' || t === 'dob')
  if (intent === 'calendar_scheduling')   return ['calendar', 'structured_retrieval']
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

// Expand a canonical neighborhood to all its known spelling variants so the
// downstream SQL contains-check matches every DB row for the area. Without
// this, asking for "Bedford-Stuyvesant" (canonical) misses 78 rows stored
// under the "Stuyvesant Heights" variant.
function expandVariants(canonical: string): readonly string[] {
  const meta = NEIGHBORHOODS[canonical]
  return meta ? meta.variants : [canonical]
}

export function buildQueryPlan(parsed: ParsedQuery): QueryPlan {
  // Single reconciliation step (Phase C): drop any LLM-supplied categories
  // that contradict the deterministic isRental flag before intent routing.
  const reconciled = reconcileIntent(parsed)
  const searchCategories = [...categoriesForIntent(parsed.intent, parsed, reconciled.categories)]

  // Resolve each parsed neighborhood (which may be a canonical or a variant)
  // to its canonical name, then expand to all variants for SQL matching.
  const canonicalSet = new Set<string>()
  const expandedFilterNeighborhoods: string[] = []
  for (const raw of parsed.neighborhoods) {
    const canonical = fromRaw(raw) ?? raw
    canonicalSet.add(canonical)
    expandedFilterNeighborhoods.push(...expandVariants(canonical))
  }
  const filterNeighborhoods = [...new Set(expandedFilterNeighborhoods)]

  // Adjacency expansion is OFF by default (Phase D.5). Users who say "in X"
  // get only X (and its variant spellings) — never Bushwick when they asked
  // for Bed-Stuy. To opt into adjacent / nearby / similar results, the user
  // must explicitly phrase the query with "near X", "around X", "or similar",
  // "nearby", etc. The parser sets parsed.broaden = true when those phrases
  // appear; queryParser.BROADEN_PATTERNS is the source of truth for what
  // counts as an explicit broaden signal.
  //
  // When broaden is false, adjacentMap stays empty and structuredRetrieval
  // builds a SQL OR over parsed.neighborhoods (variant-expanded) only.
  const adjacentMap: Record<string, string[]> = {}
  if (parsed.broaden) {
    for (const canonical of canonicalSet) {
      const adj = getAdjacent(canonical)
      const expanded = adj.flatMap(a => expandVariants(a))
      if (expanded.length > 0) adjacentMap[canonical] = [...new Set(expanded)]
    }
  }

  return {
    intent:             parsed.intent,
    searchCategories,
    excludeCategories:  ['NOISE'],
    includeReviewQueue: false,
    filters: {
      neighborhoods:       filterNeighborhoods,
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

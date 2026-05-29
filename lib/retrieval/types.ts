// ── Intent buckets ────────────────────────────────────────────────────────────
export type IntentBucket =
  | 'opportunity_search'   // "show me rentals in Williamsburg"
  | 'demand_search'        // "buyer ISOs", "renter inquiries"
  | 'seller_lead_search'   // "seller leads", "landlord leads"
  | 'match_review'         // "what fits my buyer", "anything for my client"
  | 'calendar_scheduling'  // "schedule", "book a showing", "today", "tomorrow"
  | 'property_intelligence'// "who owns X", "ACRIS", "permits", "violations"
  | 'market_question'      // "market report", "average price", "trends"
  | 'general'              // catch-all

// ── Parsed query output ───────────────────────────────────────────────────────
export interface ParsedQuery {
  raw:           string
  neighborhoods: string[]
  boroughs:      string[]
  beds:          number | null   // exact bed count if specified
  minBeds:       number | null
  maxBeds:       number | null
  // "N-family" / "multi-family" / "N-unit" → building unit count (NYC parlance).
  // Distinct from bedrooms. "2-3 family" = 2-3 residential units in the building.
  minUnits:      number | null
  maxUnits:      number | null
  minPrice:      number | null
  maxPrice:      number | null
  isRental:      boolean | null  // true=rental, false=sale, null=unclear
  categories:    string[]        // explicit category signals ("buyer ISO", "open house")
  intent:        IntentBucket
  isCalendar:    boolean
  isACRIS:       boolean
  isDOB:         boolean
  isMyBuyer:       boolean
  isSellerLead:    boolean
  isEmailCampaign: boolean
  // True only when the user explicitly asked for adjacent / nearby / similar
  // results ("near X", "around X", "or nearby", etc.). When false (the default
  // for a plain "in X" query), queryPlanner does NOT expand adjacency —
  // results are strictly the named neighborhood(s) and their variant spellings.
  broaden:         boolean
  // When the user said "last N hours/days", "today", "yesterday", "this week",
  // etc. Overrides the intent-derived default in queryPlanner. Null when no
  // explicit time phrase was detected.
  freshnessOverrideHours: number | null
  usedLLM:       boolean
  confidence:    number          // 0–1, how confident the parser is
}

// ── Query plan ────────────────────────────────────────────────────────────────
export interface QueryPlan {
  intent:              IntentBucket
  searchCategories:    string[]   // ExtractedOpportunity categories to include
  excludeCategories:   string[]   // explicitly excluded
  includeReviewQueue:  boolean
  filters: {
    neighborhoods:       string[]
    boroughs:            string[]
    minBeds:             number | null
    maxBeds:             number | null
    minUnits:            number | null
    maxUnits:            number | null
    minPrice:            number | null
    maxPrice:            number | null
    freshnessWindowDays: number
    // Hours-precise override. When set (parser detected explicit time phrase),
    // structuredRetrieval uses this instead of freshnessWindowDays.
    freshnessWindowHours: number | null
  }
  adjacentNeighborhoods: Record<string, string[]>
  tools: Array<'structured_retrieval' | 'vector_search' | 'acris' | 'dob' | 'calendar'>
}

// ── Scored record ─────────────────────────────────────────────────────────────
export interface ScoredRecord {
  id:               string
  score:            number
  tier:             'excellent' | 'good' | 'fair' | 'weak'
  grade:            'exact_match' | 'close_match' | 'weak_match' | 'irrelevant'
  category:         string
  address:          string | null
  neighborhood:     string | null
  borough:          string | null
  price:            number | null
  minPrice:         number | null
  maxPrice:         number | null
  beds:             number | null
  baths:            number | null
  units:            number | null
  propertyType:     string | null
  availabilityDate: string | null
  sourceAgentName:  string | null
  sourceAgentEmail: string | null
  sourceBrokerage:  string | null
  clientSide:       string | null
  extractedTitle:   string
  extractedSummary: string
  transactionType:  string
  createdAt:        Date
  streetEasyId:     string | null
}

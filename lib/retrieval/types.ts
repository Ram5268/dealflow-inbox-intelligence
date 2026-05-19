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
  minPrice:      number | null
  maxPrice:      number | null
  isRental:      boolean | null  // true=rental, false=sale, null=unclear
  categories:    string[]        // explicit category signals ("buyer ISO", "open house")
  intent:        IntentBucket
  isCalendar:    boolean
  isACRIS:       boolean
  isDOB:         boolean
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
    minPrice:            number | null
    maxPrice:            number | null
    freshnessWindowDays: number
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

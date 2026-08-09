// Brief 7.0 — shared types for the cross-source matching engine.
//
// The engine pairs a party (demand: a buyer or renter) with a listing (supply:
// a sale or rental). Every pair is geo-pre-filtered, LLM-tiered, ranked (with a
// hardcoded StreetEasy-Expert source boost), and returned to the caller. Nothing
// here touches production trigger paths — see lib/config/matchingTestMode.ts.

import type { Category } from '@prisma/client'

// A party↔listing pair lands in exactly one tier. 'None' is a real tiering
// verdict (hard mismatch) but NEVER appears in results — the engine filters it
// out after tiering. See lib/matching/tiering.ts for the rubric.
export type Tier = 'Hot' | 'Warm' | 'Possible' | 'None'

// Where a party came from. Drives the DETERMINISTIC ranking boost (SE first),
// not the LLM rubric. See lib/matching/ranking.ts.
export type SourceBadge = 'streeteasy_expert' | 'mojo' | 'inbox'

// Transaction side of a party's demand. A buyer matches sale supply; a renter
// matches rental supply. Enforced in the candidate query, not left to the LLM.
export type PartyRole = 'buyer' | 'renter'

// Normalized party demand, assembled from an ExtractedOpportunity (BUYER_ISO /
// RENTER_INQUIRY) or — in the deferred production path — a MojoContact.
export interface PartyContext {
  id:            string
  name:          string
  source:        SourceBadge
  role:          PartyRole
  budgetMin:     number | null
  budgetMax:     number | null
  neighborhoods: string[]       // raw strings; resolved via fromRaw() in the geo filter
  bedsMin:       number | null
  bedsMax:       number | null
  cashOnly:      boolean
  timing:        string | null  // free-text ("needs by June"), for the LLM only
  borough:       string | null  // explicit borough if known (may be null)
  createdAt:     Date
}

// Normalized supply, assembled from an ExtractedOpportunity in a SUPPLY_SALE /
// SUPPLY_RENTAL category.
export interface ListingContext {
  id:           string
  category:     Category
  side:         'sale' | 'rental'
  source:       SourceBadge
  address:      string | null
  neighborhood: string | null
  borough:      string | null
  beds:         number | null
  price:        number | null
  createdAt:    Date
}

// ── Result shapes (returned to callers / the harness) ────────────────────────

export interface PartySummary {
  id:       string
  name:     string
  source:   SourceBadge
  role:     PartyRole
  criteria: string   // human-readable, e.g. "Chelsea 2BR $1.9M–$2.2M cash"
}

export interface ListingSummary {
  id:           string
  address:      string | null
  neighborhood: string | null
  price:        number | null
  category:     Category
}

export interface MatchResult {
  id:          string          // deterministic hash of party+listing ids
  party:       PartySummary
  listing:     ListingSummary
  tier:        'Hot' | 'Warm' | 'Possible'   // never 'None' (filtered out)
  reason:      string          // one-sentence why-match from Sonnet
  rankScore:   number          // internal sort key (tier band + source boost)
  recencyDays: number          // age of the newer of the two records, in days
  sourceBadge: SourceBadge     // the PARTY's source (drives the SE boost)
}

export interface MatchQueryResult {
  results:     MatchResult[]
  totalMatched: number   // count BEFORE the cap, AFTER the None-filter + dismissals
  sortedBy:    string    // human-readable sort explanation
  costUSD:     number    // total Sonnet spend for this query
}

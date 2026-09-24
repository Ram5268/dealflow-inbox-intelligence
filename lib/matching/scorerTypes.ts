// Brief 32 — shared types for the logit-space pair scorer.
//
// Kept in a dependency-free module (type-only imports) so that features, adapters,
// eligibility, and the scorer can all import the same contracts without runtime
// import cycles. `scorer.ts` and `adapters.ts` re-export the relevant names so the
// brief's stated import surfaces still resolve.
import type { TransactionType } from '@prisma/client'

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW'

export interface FeatureResult {
  key: string // must match a key in WEIGHTS
  score: number // 0.0 - 1.0, monotonic (higher = better for MatchFit)
  confidence: Confidence
}

export interface MatchFitResult {
  matchFit: number // 0-100
  matchFitConfidence: Confidence // Brief 32.A.1: derived from unknownFactors count
  contributions: Record<string, number> // per-feature % of |total signal|
  unknownFactors: string[] // features with LOW confidence (abstained)
}

export interface ScoringContext {
  now: Date
  compsMedians: Map<string, number> // pre-computed carrying-cost medians
  substitutionCounts: Map<string, number> // pre-computed per-buyer scarcity counts
  ryanOwnedListingIds: Set<string> // for capture probability
  ryanRepresentedBuyerIds: Set<string> // for capture probability
}

// The scorer's normalized supply (listing) shape. Both ExtractedOpportunity
// listings and MojoContact SELLER contacts adapt to this (see adapters.ts).
export interface ListingData {
  id: string
  sourceType: 'opportunity' | 'contact'
  transactionType: TransactionType
  priorListingStatus: string | null
  neighborhood: string | null
  borough: string | null
  price: number | null
  beds: number | null
  baths: number | null
  propertyType: string | null
  propertyTypeDetail: string | null
  monthlyMaintenance: number | null
  monthlyCommonCharges: number | null
  monthlyTaxes: number | null
  yearBuilt: number | null
  lotSizeSqft: number | null
  buildingSqft: number | null
  unitCount: number | null
  zoningCode: string | null
  // motivation
  estimatedValue: number | null
  equityBalance: number | null
  currentLTV: number | null
  totalLoanBalance: number | null
  loanInterestRate: number | null
  preForeclosureStatus: string | null
  foreclosureAuctionDate: Date | null
  isVacant: boolean | null
  ownerOccupied: boolean | null
  alternateAddress: string | null
  address: string | null
  lastSaleDate: Date | null
  mojoList: string | null
  batchRankCategory: string | null
  // outdoor + amenities
  hasOutdoorSpace: boolean | null
  amenities: string[]
  createdAt: Date
}

// The scorer's normalized demand (buyer) shape.
export interface BuyerData {
  id: string
  sourceType: 'opportunity' | 'contact'
  transactionType: TransactionType
  category: string // BUYER_ISO for the sales scorer
  neighborhoods: string[]
  priceMin: number | null
  priceMax: number | null
  bedsMin: number | null
  bedsMax: number | null
  bathsMin: number | null
  bathsMax: number | null
  propertyTypes: string[]
  mustHaves: string | null
  dealbreakers: string | null
  buyerArchetype: string | null
  timeline: string | null
}

// Brief 32 — test fixtures. NOT a *.test.ts (not run as a suite); imported by the
// scorer unit/integration tests to build ListingData / BuyerData / ScoringContext
// with sensible all-unknown defaults, overridable per case.
import type { ListingData, BuyerData, ScoringContext } from '../scorerTypes'

export function makeListing(over: Partial<ListingData> = {}): ListingData {
  return {
    id: 'listing-1',
    sourceType: 'opportunity',
    transactionType: 'SALE',
    priorListingStatus: null,
    neighborhood: null,
    borough: null,
    price: null,
    beds: null,
    baths: null,
    propertyType: null,
    propertyTypeDetail: null,
    monthlyMaintenance: null,
    monthlyCommonCharges: null,
    monthlyTaxes: null,
    yearBuilt: null,
    lotSizeSqft: null,
    buildingSqft: null,
    unitCount: null,
    zoningCode: null,
    estimatedValue: null,
    equityBalance: null,
    currentLTV: null,
    totalLoanBalance: null,
    loanInterestRate: null,
    preForeclosureStatus: null,
    foreclosureAuctionDate: null,
    isVacant: null,
    ownerOccupied: null,
    alternateAddress: null,
    address: null,
    lastSaleDate: null,
    mojoList: null,
    batchRankCategory: null,
    hasOutdoorSpace: null,
    amenities: [],
    createdAt: new Date(),
    ...over,
  }
}

export function makeBuyer(over: Partial<BuyerData> = {}): BuyerData {
  return {
    id: 'buyer-1',
    sourceType: 'opportunity',
    transactionType: 'BUYER_NEED',
    category: 'BUYER_ISO',
    neighborhoods: [],
    priceMin: null,
    priceMax: null,
    bedsMin: null,
    bedsMax: null,
    bathsMin: null,
    bathsMax: null,
    propertyTypes: [],
    mustHaves: null,
    dealbreakers: null,
    buyerArchetype: null,
    timeline: null,
    ...over,
  }
}

export function makeContext(over: Partial<ScoringContext> = {}): ScoringContext {
  return {
    now: new Date(),
    compsMedians: new Map(),
    substitutionCounts: new Map(),
    ryanOwnedListingIds: new Set(),
    ryanRepresentedBuyerIds: new Set(),
    ...over,
  }
}

// Brief 32 — adapters translating source records to the scorer's normalized shapes.
//
// Two source tables feed the sales scorer: ExtractedOpportunity (inbox-derived,
// both listing- and buyer-side) and MojoContact (Zapier-derived SELLER/BUYER
// contacts). The scorer itself is source-agnostic — it only ever sees ListingData
// / BuyerData. Prisma model types are imported type-only (erased at runtime) so
// this module has no runtime Prisma dependency and runs under ts-node.
import type { ExtractedOpportunity, MojoContact } from '@prisma/client'
import type { ListingData, BuyerData } from './scorerTypes'
import { fromRaw, getBorough } from '../domain/Neighborhood'

// Re-export so the brief's stated import surface (types from adapters) resolves.
export type { ListingData, BuyerData } from './scorerTypes'

const OUTDOOR_KEYWORDS = ['outdoor', 'terrace', 'garden', 'balcony', 'patio', 'roof deck', 'roofdeck', 'backyard', 'back yard', 'yard']
const AMENITY_KEYWORDS: Record<string, string[]> = {
  doorman: ['doorman'],
  gym: ['gym', 'fitness'],
  parking: ['parking', 'garage'],
  elevator: ['elevator'],
  laundry: ['laundry', 'washer'],
  pool: ['pool'],
}

// Listing-side outdoor detection from free text. Presence → true; absence → null
// (unknown, NOT false — we never assert a listing lacks outdoor from silence).
function parseOutdoor(text: string): boolean | null {
  const t = text.toLowerCase()
  return OUTDOOR_KEYWORDS.some(k => t.includes(k)) ? true : null
}

function parseAmenities(text: string): string[] {
  const t = text.toLowerCase()
  const found: string[] = []
  for (const [canon, kws] of Object.entries(AMENITY_KEYWORDS)) {
    if (kws.some(k => t.includes(k))) found.push(canon)
  }
  return found
}

function boroughOf(neighborhood: string | null): string | null {
  const canon = fromRaw(neighborhood)
  return canon ? getBorough(canon) : null
}

// ── Listing adapters ────────────────────────────────────────────────────────

export function opportunityToListingData(opp: ExtractedOpportunity): ListingData {
  const text = [opp.extractedTitle, opp.extractedSummary, opp.mustHaves].filter(Boolean).join(' ')
  return {
    id: opp.id,
    sourceType: 'opportunity',
    transactionType: opp.transactionType,
    priorListingStatus: null, // EO has no prior-listing history
    neighborhood: opp.neighborhood,
    borough: opp.borough ?? boroughOf(opp.neighborhood),
    price: opp.price,
    beds: opp.beds,
    baths: opp.baths,
    propertyType: opp.propertyType,
    propertyTypeDetail: null, // detail granularity is a MojoContact-only field
    monthlyMaintenance: opp.monthlyMaintenance,
    monthlyCommonCharges: opp.monthlyCommonCharges,
    monthlyTaxes: opp.monthlyTaxes,
    yearBuilt: opp.yearBuilt,
    lotSizeSqft: opp.lotSizeSqft,
    buildingSqft: opp.squareFeet,
    unitCount: opp.units,
    zoningCode: opp.zoningCode,
    // Motivation fields live only on MojoContact seller records.
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
    address: opp.address,
    lastSaleDate: null,
    mojoList: null,
    batchRankCategory: null,
    hasOutdoorSpace: parseOutdoor(text),
    amenities: parseAmenities(text),
    createdAt: opp.createdAt,
  }
}

export function mojoContactToListingData(mc: MojoContact): ListingData {
  return {
    id: mc.id,
    sourceType: 'contact', // regen writes opportunityType='contact' off this
    transactionType: 'SALE', // a SELLER contact is sale-side supply
    priorListingStatus: mc.priorListingStatus,
    neighborhood: mc.neighborhood,
    borough: boroughOf(mc.neighborhood),
    price: mc.estimatedValue, // seller has no explicit list price — estimatedValue proxy
    beds: mc.propertyBeds,
    baths: mc.propertyBaths,
    propertyType: mc.propertyTypeDetail,
    propertyTypeDetail: mc.propertyTypeDetail,
    monthlyMaintenance: null,
    monthlyCommonCharges: null,
    monthlyTaxes: null,
    yearBuilt: mc.yearBuilt,
    lotSizeSqft: mc.lotSizeSqft,
    buildingSqft: mc.buildingSqft,
    unitCount: mc.unitCount,
    zoningCode: mc.zoningCode,
    estimatedValue: mc.estimatedValue,
    equityBalance: mc.equityBalance,
    currentLTV: mc.currentLTV,
    totalLoanBalance: mc.totalLoanBalance,
    loanInterestRate: mc.loanInterestRate,
    preForeclosureStatus: mc.preForeclosureStatus,
    foreclosureAuctionDate: mc.foreclosureAuctionDate,
    isVacant: mc.isVacant,
    ownerOccupied: mc.ownerOccupied,
    alternateAddress: mc.alternateAddress,
    address: mc.address,
    lastSaleDate: mc.lastSaleDate,
    mojoList: mc.mojoList,
    batchRankCategory: mc.batchRankCategory,
    hasOutdoorSpace: null, // unknown for seller contacts
    amenities: [],
    createdAt: mc.createdAt,
  }
}

// ── Buyer adapters ──────────────────────────────────────────────────────────

export function opportunityToBuyerData(opp: ExtractedOpportunity): BuyerData {
  const hoods = opp.neighborhoods.length
    ? opp.neighborhoods
    : opp.neighborhood
      ? [opp.neighborhood]
      : []
  return {
    id: opp.id,
    sourceType: 'opportunity',
    transactionType: opp.transactionType,
    category: opp.category, // BUYER_ISO for the sales scorer
    neighborhoods: hoods,
    // Scalar price/beds collapse to a point range so range-aware features still fire.
    priceMin: opp.minPrice ?? opp.price,
    priceMax: opp.maxPrice ?? opp.price,
    bedsMin: opp.minBeds ?? opp.beds,
    bedsMax: opp.maxBeds ?? opp.beds,
    bathsMin: opp.bathsMin,
    bathsMax: opp.bathsMax,
    propertyTypes: opp.propertyTypes,
    mustHaves: opp.mustHaves,
    dealbreakers: opp.dealbreakers,
    buyerArchetype: opp.buyerArchetype,
    timeline: opp.timeline,
  }
}

export function mojoContactToBuyerData(mc: MojoContact): BuyerData {
  const hoods = mc.neighborhood
    ? [mc.neighborhood]
    : mc.initialNeighborhood
      ? [mc.initialNeighborhood]
      : []
  return {
    id: mc.id,
    sourceType: 'contact',
    transactionType: 'BUYER_NEED',
    category: 'BUYER_ISO', // mojo BUYER contacts are treated as buyer-ISO demand
    neighborhoods: hoods,
    priceMin: mc.budgetMin,
    priceMax: mc.budgetMax,
    bedsMin: mc.bedsMin,
    bedsMax: mc.bedsMax,
    // MojoContact has no baths criteria columns → no preference (feature neutral-passes).
    bathsMin: null,
    bathsMax: null,
    propertyTypes: [],
    mustHaves: mc.notes,
    dealbreakers: null,
    buyerArchetype: mc.cashOnly === true ? 'CASH_BUYER' : null,
    timeline: mc.timing,
  }
}

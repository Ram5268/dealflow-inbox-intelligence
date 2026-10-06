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
import { listingBorough } from './borough'

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
    priorListingPrice: null,
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
  // Brief 35: Mojo beds/baths are building totals. 2-4 unit buildings are scored
  // per unit; a "5+ units" total can't be split, and under 1 bed per unit is
  // implausible, so both count as unknown.
  const units = mc.unitCount ?? 1
  const perUnit = (v: number | null) => (units >= 5 ? null : v != null && units >= 2 ? Math.round((v / units) * 10) / 10 : v)
  const bedsPerUnit = perUnit(mc.propertyBeds)
  return {
    id: mc.id,
    sourceType: 'contact', // regen writes opportunityType='contact' off this
    transactionType: 'SALE', // a SELLER contact is sale-side supply
    // Upper-cased once here so every check agrees, including the REBNY "currently
    // listed" exclusion (eligibility.ts step 3), whatever the source's spelling.
    priorListingStatus: mc.priorListingStatus?.trim().toUpperCase() || null,
    priorListingPrice: mc.priorListingPrice,
    neighborhood: mc.neighborhood,
    borough: listingBorough(mc.neighborhood, mc.zipCode), // Brief 35: ZIP/label fallback
    price: mc.estimatedValue, // seller has no explicit list price — estimatedValue proxy
    beds: units >= 2 && bedsPerUnit != null && bedsPerUnit < 1 ? null : bedsPerUnit,
    baths: perUnit(mc.propertyBaths),
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
    // A one-sided budget stays open: mapISO fills `price` from a lone max or min, which
    // used to turn "up to $1.6M" (or "$1.6M+") into exactly $1.6M.
    priceMin: opp.minPrice ?? (opp.maxPrice == null ? opp.price : null),
    priceMax: opp.maxPrice ?? (opp.minPrice == null ? opp.price : null),
    // Beds likewise (Brief 41): mapISO fills `beds` from a lone min or max, which
    // turned "2+ BR" into exactly 2. A scalar with no range is still exact.
    bedsMin: opp.minBeds ?? (opp.maxBeds == null ? opp.beds : null),
    bedsMax: opp.maxBeds ?? (opp.minBeds == null ? opp.beds : null),
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

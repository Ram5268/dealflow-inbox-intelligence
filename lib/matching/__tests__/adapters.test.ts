import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ExtractedOpportunity, MojoContact } from '@prisma/client'
import {
  opportunityToListingData,
  mojoContactToListingData,
  opportunityToBuyerData,
  mojoContactToBuyerData,
} from '../adapters'

const CREATED = new Date('2026-08-01T00:00:00Z')

// Partial builders cast to the Prisma row types (adapters only read a subset).
function opp(over: Record<string, unknown>): ExtractedOpportunity {
  return {
    id: 'opp-1', transactionType: 'SALE', category: 'ACTIVE_SALE_LISTING',
    propertyType: null, neighborhood: null, borough: null, price: null, minPrice: null, maxPrice: null,
    beds: null, baths: null, units: null, squareFeet: null, address: null,
    monthlyMaintenance: null, monthlyCommonCharges: null, monthlyTaxes: null,
    yearBuilt: null, lotSizeSqft: null, zoningCode: null, buyerArchetype: null,
    neighborhoods: [], propertyTypes: [], minBeds: null, maxBeds: null,
    mustHaves: null, dealbreakers: null, timeline: null,
    extractedTitle: 'T', extractedSummary: 'S', createdAt: CREATED,
    ...over,
  } as unknown as ExtractedOpportunity
}

function contact(over: Record<string, unknown>): MojoContact {
  return {
    id: 'mc-1', fullName: 'Jane Seller', neighborhood: null, initialNeighborhood: null,
    address: null, estimatedValue: null, equityBalance: null, currentLTV: null,
    totalLoanBalance: null, loanInterestRate: null, mojoList: null,
    propertyBeds: null, propertyBaths: null, propertyTypeDetail: null,
    preForeclosureStatus: null, foreclosureAuctionDate: null, isVacant: null, ownerOccupied: null,
    alternateAddress: null, lastSaleDate: null, yearBuilt: null, unitCount: null,
    buildingSqft: null, lotSizeSqft: null, zoningCode: null, batchRankCategory: null,
    priorListingStatus: null, budgetMin: null, budgetMax: null, bedsMin: null, bedsMax: null,
    cashOnly: null, timing: null, notes: null, createdAt: CREATED,
    ...over,
  } as unknown as MojoContact
}

test('opportunityToListingData preserves fields correctly', () => {
  const l = opportunityToListingData(opp({
    neighborhood: 'Chelsea', borough: 'Manhattan', price: 1_500_000, beds: 2, baths: 2,
    squareFeet: 1100, units: 1, propertyType: 'condo', monthlyMaintenance: 900, address: '1 W 20th St',
  }))
  assert.equal(l.sourceType, 'opportunity')
  assert.equal(l.neighborhood, 'Chelsea')
  assert.equal(l.beds, 2)
  assert.equal(l.buildingSqft, 1100) // squareFeet → buildingSqft
  assert.equal(l.unitCount, 1) // units → unitCount
  assert.equal(l.propertyType, 'condo')
  assert.equal(l.propertyTypeDetail, null) // EO has no detail
  assert.equal(l.equityBalance, null) // motivation is MojoContact-only
})

test('mojoContactToListingData maps propertyBeds → beds and estimatedValue → price', () => {
  const l = mojoContactToListingData(contact({
    propertyBeds: 3, propertyBaths: 2, estimatedValue: 2_400_000, propertyTypeDetail: 'Townhouse',
    preForeclosureStatus: 'LIS_PENDENS', equityBalance: 2_000_000, mojoList: 'NYC Pre-Foreclosure',
  }))
  assert.equal(l.sourceType, 'contact')
  assert.equal(l.transactionType, 'SALE')
  assert.equal(l.beds, 3)
  assert.equal(l.baths, 2)
  assert.equal(l.price, 2_400_000)
  assert.equal(l.propertyType, 'Townhouse')
  assert.equal(l.preForeclosureStatus, 'LIS_PENDENS')
  assert.equal(l.mojoList, 'NYC Pre-Foreclosure')
})

test('opportunityToBuyerData handles BUYER_ISO shape', () => {
  const b = opportunityToBuyerData(opp({
    category: 'BUYER_ISO', transactionType: 'BUYER_NEED', neighborhoods: ['Chelsea', 'West Village'],
    minPrice: 1_000_000, maxPrice: 2_000_000, minBeds: 2, maxBeds: 3,
    propertyTypes: ['condo'], buyerArchetype: 'CASH_BUYER',
  }))
  assert.equal(b.sourceType, 'opportunity')
  assert.equal(b.category, 'BUYER_ISO')
  assert.deepEqual(b.neighborhoods, ['Chelsea', 'West Village'])
  assert.equal(b.priceMin, 1_000_000)
  assert.equal(b.bedsMax, 3)
  assert.equal(b.buyerArchetype, 'CASH_BUYER')
})

test('mojoContactToBuyerData handles MojoContact BUYER intent', () => {
  const b = mojoContactToBuyerData(contact({
    neighborhood: 'Park Slope', budgetMin: 800_000, budgetMax: 1_200_000, bedsMin: 2, bedsMax: 3, cashOnly: true,
  }))
  assert.equal(b.sourceType, 'contact')
  assert.equal(b.category, 'BUYER_ISO')
  assert.equal(b.transactionType, 'BUYER_NEED')
  assert.deepEqual(b.neighborhoods, ['Park Slope'])
  assert.equal(b.priceMin, 800_000)
  assert.equal(b.bedsMin, 2)
  assert.equal(b.buyerArchetype, 'CASH_BUYER') // cashOnly → CASH_BUYER
})

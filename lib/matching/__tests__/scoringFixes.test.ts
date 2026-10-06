// Brief 41 (PR 2) — regression tests for the Brief 40 audit's matching-score
// findings H2, M7, M8, M9 and M10, ported from the auditor's proof tests. Each
// one failed on main 7c4f063. Pure: type-only Prisma imports, no DB, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ExtractedOpportunity, MojoContact } from '@prisma/client'
import { bedsScore } from '../bedsScore'
import { isBedsEligible } from '../eligibility'
import { computeBeds } from '../features/beds'
import { computeBaths } from '../features/baths'
import { computePropertyType } from '../features/propertyType'
import { computeAbsenteeOwner } from '../features/absenteeOwner'
import { computeBuyerArchetypeSituation } from '../features/buyerArchetypeSituation'
import { computeRecency } from '../features/recency'
import { scorePair } from '../scorer'
import { mojoContactToListingData, opportunityToBuyerData } from '../adapters'
import { propertyClass } from '../propertyTypes'
import { tierOf } from '../nightly/select'
import { makeBuyer, makeContext, makeListing } from './fixtures'
import type { ScoringContext } from '../scorerTypes'

const CREATED = new Date('2026-09-25T12:00:00Z')
const DAY = 86_400_000

function contact(over: Record<string, unknown>): MojoContact {
  return {
    id: 'seller-1', fullName: 'Seller', neighborhood: null, initialNeighborhood: null, zipCode: null,
    address: '10 Test St', estimatedValue: null, equityBalance: null, currentLTV: null,
    totalLoanBalance: null, loanInterestRate: null, mojoList: null,
    propertyBeds: null, propertyBaths: null, propertyTypeDetail: null,
    preForeclosureStatus: null, foreclosureAuctionDate: null, isVacant: null, ownerOccupied: null,
    alternateAddress: null, lastSaleDate: null, yearBuilt: null, unitCount: null,
    buildingSqft: null, lotSizeSqft: null, zoningCode: null, batchRankCategory: null,
    priorListingStatus: null, priorListingPrice: null, budgetMin: null, budgetMax: null, bedsMin: null, bedsMax: null,
    cashOnly: null, timing: null, notes: null, createdAt: CREATED,
    ...over,
  } as unknown as MojoContact
}
function opp(over: Record<string, unknown>): ExtractedOpportunity {
  return {
    id: 'buyer-1', transactionType: 'BUYER_NEED', category: 'BUYER_ISO',
    propertyType: null, neighborhood: null, borough: null, price: null, minPrice: null, maxPrice: null,
    beds: null, baths: null, units: null, squareFeet: null, address: null,
    monthlyMaintenance: null, monthlyCommonCharges: null, monthlyTaxes: null,
    yearBuilt: null, lotSizeSqft: null, zoningCode: null, buyerArchetype: null,
    neighborhoods: [], propertyTypes: [], minBeds: null, maxBeds: null, bathsMin: null, bathsMax: null,
    mustHaves: null, dealbreakers: null, timeline: null,
    extractedTitle: 'T', extractedSummary: 'S', createdAt: CREATED,
    ...over,
  } as unknown as ExtractedOpportunity
}
const ctx = (now: Date): ScoringContext => ({
  now, compsMedians: new Map(), substitutionCounts: new Map([['buyer-1', 12]]),
  ryanOwnedListingIds: new Set(), ryanRepresentedBuyerIds: new Set(),
})
// A [TEST_32]-style INVESTOR_LANDLORD buyer (scripts/seed-brief32-buyers.ts shape).
const investor = opportunityToBuyerData(opp({
  neighborhoods: ['Bushwick'], minPrice: 1_500_000, maxPrice: 3_000_000, minBeds: 3, maxBeds: 6,
  propertyTypes: ['Multifamily', 'Duplex', 'Townhouse'], buyerArchetype: 'INVESTOR_LANDLORD', mustHaves: 'positive cash flow',
}))
const duplex = (beds: number) => mojoContactToListingData(contact({
  neighborhood: 'Bushwick', zipCode: '11237', unitCount: 2, propertyBeds: beds, propertyBaths: 2, propertyTypeDetail: 'Duplex',
}))

// ── H2: fractional per-unit beds ────────────────────────────────────────────
test('H2: a closer duplex (2.5 beds/unit) never scores below a farther one (2.0) for a 3-6BR buyer', () => {
  assert.ok(bedsScore(2.5, null, 3, 6) >= bedsScore(2.0, null, 3, 6), `${bedsScore(2.5, null, 3, 6)} vs ${bedsScore(2.0, null, 3, 6)}`)
  const d5 = duplex(5), d4 = duplex(4)
  assert.equal(d5.beds, 2.5)
  assert.equal(isBedsEligible(2.5, 3, 6), true)
  const f5 = computeBeds(d5, investor), f4 = computeBeds(d4, investor)
  assert.ok(f5.score > f4.score, `2.5 beds/unit scored ${f5.score}; 2.0 beds/unit scored ${f4.score}`)
  const m5 = scorePair(d5, investor, ctx(CREATED)).matchFit.matchFit
  const m4 = scorePair(d4, investor, ctx(CREATED)).matchFit.matchFit
  assert.ok(m5 >= m4, `matchFit 2.5/unit ${m5} vs 2.0/unit ${m4}`)
})

test('H2: the ±1 band scales for part-bedroom gaps and keeps whole-bedroom results', () => {
  assert.equal(bedsScore(2.5, null, 3, 6), 15)
  assert.equal(bedsScore(2.3, null, 3, 6), 13)
  assert.equal(bedsScore(6.5, null, 3, 6), 15)
  assert.equal(bedsScore(3.3, null, 2, 2.3), 10) // a float-noise gap of exactly 1 is still in the band
  assert.equal(bedsScore(2, null, 3, 6), 10)
  assert.equal(bedsScore(1.9, null, 3, 6), 0)
  assert.equal(bedsScore(4, null, 2, 3), 10)
  assert.equal(bedsScore(5, null, 2, 2), 0)
  assert.deepEqual(computeBeds(makeListing({ beds: 2.5 }), makeBuyer({ bedsMin: 3, bedsMax: 6 })), { key: 'beds', score: 0.75, confidence: 'HIGH' })
})

// ── M10: open-ended bed ranges ──────────────────────────────────────────────
test('M10: a "2+ BR" buyer accepts a 4BR; an "up to 3BR" buyer accepts a 1BR', () => {
  assert.equal(isBedsEligible(4, 2, null), true)
  assert.equal(bedsScore(4, null, 2, null), 20)
  assert.equal(bedsScore(1, null, null, 3), 20)
  assert.equal(bedsScore(4, null, null, 3), 10) // still ±1 past an "up to" bound
  const l = makeListing({ beds: 4, baths: 3 })
  const b = makeBuyer({ bedsMin: 2, bedsMax: null, bathsMin: 2, bathsMax: null })
  assert.deepEqual(computeBaths(l, b), { key: 'baths', score: 1, confidence: 'HIGH' })
  assert.deepEqual(computeBeds(l, b), { key: 'beds', score: 1, confidence: 'HIGH' })
})

test('M10: scalar and fully-unknown cases are unchanged', () => {
  assert.equal(bedsScore(3, 2, 1, 5), 10) // scalar wins, exact count
  assert.equal(bedsScore(2, 2), 20)
  assert.equal(bedsScore(2, null, null, null), 5)
  assert.equal(bedsScore(null, null, 2, null), 5)
})

test('M10: an inbox ISO saying "2+ BR" stays open-ended through the adapter (mapISO fills beds from the lone min)', () => {
  const plus = opportunityToBuyerData(opp({ minBeds: 2, maxBeds: null, beds: 2 }))
  assert.equal(plus.bedsMin, 2)
  assert.equal(plus.bedsMax, null)
  const upTo = opportunityToBuyerData(opp({ minBeds: null, maxBeds: 3, beds: 3 }))
  assert.equal(upTo.bedsMin, null)
  assert.equal(upTo.bedsMax, 3)
  const exact = opportunityToBuyerData(opp({ minBeds: null, maxBeds: null, beds: 3 }))
  assert.equal(exact.bedsMin, 3)
  assert.equal(exact.bedsMax, 3)
  const range = opportunityToBuyerData(opp({ minBeds: 2, maxBeds: 3, beds: 2.5 }))
  assert.equal(range.bedsMin, 2)
  assert.equal(range.bedsMax, 3)
})

// ── M7: one property-type vocabulary ────────────────────────────────────────
test('M7: a buyer asking for "Multifamily" matches every CRM multi-family type', () => {
  const buyer1031 = opportunityToBuyerData(opp({
    neighborhoods: ['Bushwick'], minPrice: 1_500_000, maxPrice: 4_000_000, minBeds: 2, maxBeds: 3,
    propertyTypes: ['Condo', 'Multifamily'], buyerArchetype: 'EXCHANGE_1031',
  }))
  for (const [t, units] of [['Duplex', 2], ['Triplex', 3], ['Quadruplex', 4], ['Multi-Family Dwelling', null], ['Residential Income (Multi-Family)', null], ['Apartment House (5+ Units)', 5]] as const) {
    const l = mojoContactToListingData(contact({ neighborhood: 'Bushwick', zipCode: '11237', unitCount: units, propertyBeds: units ? units * 2 : 4, propertyTypeDetail: t }))
    assert.deepEqual(computePropertyType(l, buyer1031), { key: 'propertyType', score: 1, confidence: 'HIGH' }, t)
  }
})

test('M7: shared vocabulary on both sides', () => {
  const cases: [string, string | null][] = [
    ['Multifamily', 'multifamily'], ['multi-family', 'multifamily'], ['2-family', 'multifamily'], ['Two Family', 'multifamily'],
    ['Duplex', 'multifamily'], ['Triplex', 'multifamily'], ['Residential Income (Multi-Family)', 'multifamily'],
    ['Condo', 'condo'], ['condominium', 'condo'], ['Coop', 'coop'], ['co-op', 'coop'], ['Cooperative', 'coop'],
    ['SFH', 'single_family'], ['single family', 'single_family'], ['Townhouse', 'townhouse'], ['brownstone', 'townhouse'],
    ['duplex condo', 'condo'], ['mixed-use', 'mixed_use'], ['loft', null], ['', null],
  ]
  for (const [text, want] of cases) assert.equal(propertyClass(text), want, text)
})

test('M7: a real mismatch stays HIGH; text outside the vocabulary is only MEDIUM', () => {
  const triplex = makeListing({ propertyType: 'Triplex', unitCount: 3 })
  assert.deepEqual(computePropertyType(triplex, makeBuyer({ propertyTypes: ['Condo', 'Coop'] })), { key: 'propertyType', score: 0.2, confidence: 'HIGH' })
  assert.deepEqual(computePropertyType(triplex, makeBuyer({ propertyTypes: ['Loft'] })), { key: 'propertyType', score: 0.2, confidence: 'MEDIUM' })
  assert.deepEqual(computePropertyType(makeListing({ propertyType: 'Houseboat' }), makeBuyer({ propertyTypes: ['Condo'] })), { key: 'propertyType', score: 0.2, confidence: 'MEDIUM' })
  // unchanged: exact words, no buyer preference, unknown listing type
  assert.equal(computePropertyType(makeListing({ propertyType: 'Loft' }), makeBuyer({ propertyTypes: ['loft'] })).score, 1)
  assert.deepEqual(computePropertyType(triplex, makeBuyer({ propertyTypes: [] })), { key: 'propertyType', score: 0.8, confidence: 'MEDIUM' })
  assert.deepEqual(computePropertyType(makeListing(), makeBuyer({ propertyTypes: ['Condo'] })), { key: 'propertyType', score: 0.5, confidence: 'LOW' })
})

// ── M8: absentee owner ──────────────────────────────────────────────────────
test('M8: an owner-occupied CRM seller (mailing = property street) is not absentee in either feature', () => {
  const row = (over: Record<string, unknown>) => mojoContactToListingData(contact({
    address: '361 Degraw St # 3', neighborhood: 'Carroll Gardens', zipCode: '11231',
    propertyTypeDetail: 'Duplex', unitCount: 2, propertyBeds: 6, propertyBaths: 4, ...over,
  }))
  const ownerOcc = row({ alternateAddress: '361 Degraw Street, Brooklyn, NY', ownerOccupied: true })
  const noMailing = row({ alternateAddress: null, ownerOccupied: null })
  const investorCG = makeBuyer({ neighborhoods: ['Carroll Gardens'], bedsMin: 3, bedsMax: 6, buyerArchetype: 'INVESTOR_LANDLORD' })
  assert.equal(computeAbsenteeOwner(ownerOcc).score, 0.4)
  assert.equal(computeBuyerArchetypeSituation(ownerOcc, investorCG).score, 0.85)
  assert.equal(computeBuyerArchetypeSituation(noMailing, investorCG).score, 0.85)
  // ownerOccupied unknown: the mailing street is compared normalised (St = Street, unit suffix ignored)
  const sameStreet = row({ alternateAddress: '361 Degraw Street, Brooklyn, NY', ownerOccupied: null })
  assert.equal(computeAbsenteeOwner(sameStreet).score, 0.4)
  assert.equal(computeBuyerArchetypeSituation(sameStreet, investorCG).score, 0.85)
  const elsewhere = row({ alternateAddress: '9 Palm Ave, Miami, FL', ownerOccupied: null })
  assert.equal(computeAbsenteeOwner(elsewhere).score, 1)
  assert.equal(computeBuyerArchetypeSituation(elsewhere, investorCG).score, 1)
  assert.equal(computeBuyerArchetypeSituation(row({ ownerOccupied: false }), investorCG).score, 1)
})

// ── M9: recency abstains for contact supply ─────────────────────────────────
test('M9: an identical CRM seller + buyer pair keeps its score and tier as the import date ages', () => {
  const cashBuyer = opportunityToBuyerData(opp({
    neighborhoods: ['Williamsburg'], minPrice: 1_000_000, maxPrice: 3_000_000, minBeds: 2, maxBeds: 3,
    propertyTypes: ['Condo', 'Coop'], buyerArchetype: 'CASH_BUYER', mustHaves: 'outdoor space',
  }))
  const seller = mojoContactToListingData(contact({ neighborhood: 'Bushwick', zipCode: '11237', unitCount: 2, propertyBeds: 6, propertyBaths: 2, propertyTypeDetail: 'Duplex' }))
  const at = (d: number) => scorePair(seller, cashBuyer, ctx(new Date(CREATED.getTime() + d * DAY))).matchFit.matchFit
  const series = [0, 7, 14, 30].map(at)
  assert.deepEqual(new Set(series).size, 1, series.join(' | '))
  assert.equal(tierOf(at(14)), tierOf(at(0)))
  assert.deepEqual(computeRecency(seller, new Date()), { key: 'recency', score: 0.5, confidence: 'LOW' })
})

test('M9: inbox listings still decay with age', () => {
  const now = new Date('2026-08-23T00:00:00Z')
  const fresh = computeRecency(makeListing({ createdAt: now }), now)
  const old = computeRecency(makeListing({ createdAt: new Date(now.getTime() - 30 * DAY) }), now)
  assert.equal(fresh.confidence, 'HIGH')
  assert.ok(fresh.score > old.score)
  void makeContext
})

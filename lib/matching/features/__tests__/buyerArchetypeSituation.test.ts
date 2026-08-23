import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeBuyerArchetypeSituation } from '../buyerArchetypeSituation'
import { makeListing, makeBuyer } from '../../__tests__/fixtures'

test('CASH_BUYER × LIS_PENDENS → 1.0', () => {
  const r = computeBuyerArchetypeSituation(
    makeListing({ preForeclosureStatus: 'LIS_PENDENS' }),
    makeBuyer({ buyerArchetype: 'CASH_BUYER' }),
  )
  assert.equal(r.score, 1.0)
  assert.equal(r.confidence, 'HIGH')
})

test('TRADITIONAL_FINANCING × AUCTION_SCHEDULED → 0.3', () => {
  assert.equal(
    computeBuyerArchetypeSituation(
      makeListing({ preForeclosureStatus: 'AUCTION_SCHEDULED' }),
      makeBuyer({ buyerArchetype: 'TRADITIONAL_FINANCING' }),
    ).score,
    0.3,
  )
})

test('LUXURY_ALL_CASH × sub-$2M → 0.2', () => {
  assert.equal(
    computeBuyerArchetypeSituation(
      makeListing({ price: 1_500_000 }),
      makeBuyer({ buyerArchetype: 'LUXURY_ALL_CASH' }),
    ).score,
    0.2,
  )
})

test('INVESTOR_LANDLORD × multifamily + absentee → 1.0', () => {
  assert.equal(
    computeBuyerArchetypeSituation(
      makeListing({ unitCount: 3, propertyTypeDetail: 'Triplex', ownerOccupied: false }),
      makeBuyer({ buyerArchetype: 'INVESTOR_LANDLORD' }),
    ).score,
    1.0,
  )
})

test('null archetype → 0.7 LOW', () => {
  const r = computeBuyerArchetypeSituation(makeListing(), makeBuyer({ buyerArchetype: null }))
  assert.equal(r.score, 0.7)
  assert.equal(r.confidence, 'LOW')
})

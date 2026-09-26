import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MojoContact } from '@prisma/client'
import { boroughFromLabel, boroughFromZip, boroughLabels, listingBorough } from '../borough'
import { mojoContactToListingData } from '../adapters'

// Brief 35: borough fallback for labels that aren't known neighborhoods.

test('borough-name labels, case-insensitive', () => {
  assert.equal(boroughFromLabel('Brooklyn'), 'Brooklyn')
  assert.equal(boroughFromLabel(' queens '), 'Queens')
  assert.equal(boroughFromLabel('MANHATTAN'), 'Manhattan')
  assert.equal(boroughFromLabel('Bronx'), 'Bronx')
  assert.equal(boroughFromLabel('The Bronx'), 'Bronx')
  assert.equal(boroughFromLabel('Staten Island'), 'Staten Island')
  assert.equal(boroughFromLabel('Eastern Parkway'), null)
  assert.equal(boroughFromLabel(null), null)
})

test('ZIP prefixes (ZIP+4 accepted)', () => {
  for (const [zip, borough] of [
    ['10001', 'Manhattan'], ['10128', 'Manhattan'], ['10280', 'Manhattan'], ['10301', 'Staten Island'],
    ['10451', 'Bronx'], ['11221-1230', 'Brooklyn'], ['11004', 'Queens'], ['11101', 'Queens'],
    ['11385', 'Queens'], ['11432', 'Queens'], ['11691', 'Queens'],
  ]) assert.equal(boroughFromZip(zip), borough, zip)
  for (const zip of ['11501', '07030', '361 Degraw St', '1122', '', null]) assert.equal(boroughFromZip(zip), null, String(zip))
})

test('seller borough order: canonical neighborhood → ZIP prefix → borough label', () => {
  assert.equal(listingBorough('Park Slope', '11385'), 'Brooklyn') // a canonical label wins
  assert.equal(listingBorough('Brooklyn', '11385-1234'), 'Queens') // the ZIP beats a borough label
  assert.equal(listingBorough('Staten Island', null), 'Staten Island') // label when there's no ZIP
  assert.equal(listingBorough('Eastern Parkway', '11213'), 'Brooklyn') // unrecognized label → ZIP
  assert.equal(listingBorough('Eastern Parkway', null), null)
  assert.equal(listingBorough(null, null), null)
})

test('buyer borough labels: only plain borough names count', () => {
  assert.deepEqual(boroughLabels(['Manhattan', 'Park Slope', 'the bronx', 'Eastern Parkway']), ['Manhattan', 'Bronx'])
  assert.deepEqual(boroughLabels([]), [])
})

const seller = (over: Record<string, unknown>) =>
  mojoContactToListingData({ id: 'mc', createdAt: new Date(), ...over } as unknown as MojoContact)

test('per-unit beds/baths: 2-4 units split; 5+ units and < 1 bed per unit are unknown', () => {
  const l = (unitCount: number | null, propertyBeds: number | null, propertyBaths: number | null) =>
    seller({ unitCount, propertyBeds, propertyBaths })
  assert.deepEqual([l(2, 5, 3).beds, l(2, 5, 3).baths], [2.5, 1.5])
  assert.deepEqual([l(3, 9, 7).beds, l(3, 9, 7).baths], [3, 2.3])
  assert.deepEqual([l(4, 3, 2).beds, l(4, 3, 2).baths], [null, 0.5]) // 0.8 beds per unit → unknown
  assert.deepEqual([l(5, 12, 6).beds, l(5, 12, 6).baths], [null, null]) // "Apartment House (5+ Units)"
  assert.deepEqual([l(1, 3, 2).beds, l(null, 3, 2).beds, l(null, 0.5, null).beds], [3, 3, 0.5]) // unchanged
  assert.deepEqual([l(3, null, null).beds, l(3, null, null).baths], [null, null])
})

test('Mojo seller adapter uses the borough fallback', () => {
  assert.equal(seller({ neighborhood: 'Brooklyn', zipCode: '11385-1234' }).borough, 'Queens')
  assert.equal(seller({ neighborhood: 'Brooklyn', zipCode: null }).borough, 'Brooklyn')
  assert.equal(seller({ neighborhood: 'Ridgewood', zipCode: '11221' }).borough, 'Queens') // labels stay authoritative
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NYC_ZIP_NEIGHBORHOODS, zipToNeighborhood } from '../zipNeighborhood'

test('the 7 CRM ZIPs added in Brief 34 resolve to canonical names', () => {
  assert.equal(zipToNeighborhood('11385'), 'Ridgewood')
  assert.equal(zipToNeighborhood('11237'), 'Bushwick')
  assert.equal(zipToNeighborhood('11220'), 'Sunset Park')
  assert.equal(zipToNeighborhood('11378'), 'Maspeth')
  assert.equal(zipToNeighborhood('11249'), 'Williamsburg')
  assert.equal(zipToNeighborhood('11219'), 'Borough Park')
  assert.equal(zipToNeighborhood('11226'), 'Flatbush')
})

test('split ZIPs stay unmapped', () => {
  for (const z of ['11207', '11232', '11218']) assert.equal(zipToNeighborhood(z), null, z)
})

test('existing entries are unchanged, canonicalized', () => {
  assert.equal(zipToNeighborhood('11216'), 'Crown Heights')
  assert.equal(zipToNeighborhood('11221'), 'Bushwick')
  assert.equal(zipToNeighborhood('11233'), 'Bedford-Stuyvesant')
  assert.equal(zipToNeighborhood('10010'), 'Gramercy Park')
  assert.equal(Object.keys(NYC_ZIP_NEIGHBORHOODS).length, 37 + 7)
})

test('exact 5-digit lookup: ZIP+4 accepted, junk and unknown ZIPs → null', () => {
  assert.equal(zipToNeighborhood('11231-0959'), 'Carroll Gardens')
  assert.equal(zipToNeighborhood(' 11222 '), 'Greenpoint')
  assert.equal(zipToNeighborhood('88 Example St'), null)
  assert.equal(zipToNeighborhood('1122'), null)
  assert.equal(zipToNeighborhood('99999'), null)
  assert.equal(zipToNeighborhood(null), null)
})

test('every value in the map canonicalizes', () => {
  for (const z of Object.keys(NYC_ZIP_NEIGHBORHOODS)) assert.ok(zipToNeighborhood(z), z)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isOwnerOccupied, normalizeStreet } from '../addressNormalize'

const same = (a: string, b: string) => assert.equal(normalizeStreet(a), normalizeStreet(b), `${a} ≟ ${b}`)
const differ = (a: string, b: string) => assert.notEqual(normalizeStreet(a), normalizeStreet(b), `${a} ≠ ${b}`)

test('St/Street, Ave/Avenue, Pl/Place', () => {
  same('361 Degraw St', '361 Degraw Street')
  same('1180 Jefferson Ave', '1180 Jefferson Avenue')
  same('127 3rd Pl', '127 3rd Place')
  assert.equal(normalizeStreet('127 3rd Pl'), '127 3 place')
})

test('unit suffixes are dropped', () => {
  same('361 Degraw St # 3', '361 Degraw St')
  same('280 Montgomery St # DOOR', '280 Montgomery St')
  same('1630 Norman St Apt 1R', '1630 Norman St')
  same('12 Main St Unit 2', '12 Main St')
})

test('case, punctuation, ordinals, directions, Saint, hyphenated house numbers', () => {
  same('220 N 6th St', '220 NORTH 6TH STREET')
  same('115 St. Marks Ave', '115 Saint Marks Avenue')
  same("115 St Mark's Ave", '115 St Marks Ave')
  same('18-14 Stephen St', '1814 Stephen St')
  same('6066 54th Pl', '6066 54 Place')
  differ('361 Degraw St', '363 Degraw St')
  differ('220 N 6th St', '220 S 6th St')
})

test('empty input → null', () => {
  assert.equal(normalizeStreet(''), null)
  assert.equal(normalizeStreet(null), null)
  assert.equal(normalizeStreet(' # 3'), null)
})

test('ownerOccupied: true / false / null', () => {
  assert.equal(isOwnerOccupied('361 Degraw St # 3', 'Brooklyn', '361 DEGRAW STREET', 'brooklyn'), true)
  assert.equal(isOwnerOccupied('361 Degraw St', 'Brooklyn', '524 57th St', 'Brooklyn'), false)
  assert.equal(isOwnerOccupied('361 Degraw St', 'Brooklyn', '361 Degraw St', 'Ridgewood'), false) // city differs
  assert.equal(isOwnerOccupied('361 Degraw St', 'Brooklyn', null, 'Brooklyn'), null)
  assert.equal(isOwnerOccupied('361 Degraw St', 'Brooklyn', '  ', null), null)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isOwnerOccupied, normalizeStreet } from '../addressNormalize'

const same = (a: string, b: string) => assert.equal(normalizeStreet(a), normalizeStreet(b), `${a} ≟ ${b}`)
const differ = (a: string, b: string) => assert.notEqual(normalizeStreet(a), normalizeStreet(b), `${a} ≠ ${b}`)

test('St/Street, Ave/Avenue, Pl/Place', () => {
  same('88 Example St', '88 Example Street')
  same('14 Sample Ave', '14 Sample Avenue')
  same('7 999th Pl', '7 999th Place')
  assert.equal(normalizeStreet('7 999th Pl'), '7 999 place')
})

test('unit suffixes are dropped', () => {
  same('88 Example St # 3', '88 Example St')
  same('21 Example St # DOOR', '21 Example St')
  same('30 Sample St Apt 1R', '30 Sample St')
  same('12 Sample St Unit 2', '12 Sample St')
})

test('case, punctuation, ordinals, directions, Saint, hyphenated house numbers', () => {
  same('40 N 999th St', '40 NORTH 999TH STREET')
  same('15 St. Examples Ave', '15 Saint Examples Avenue')
  same("15 St Example's Ave", '15 St Examples Ave')
  same('12-34 Example St', '1234 Example St')
  same('56 888th Pl', '56 888 Place')
  differ('88 Example St', '363 Example St')
  differ('40 N 999th St', '40 S 999th St')
})

test('empty input → null', () => {
  assert.equal(normalizeStreet(''), null)
  assert.equal(normalizeStreet(null), null)
  assert.equal(normalizeStreet(' # 3'), null)
})

test('ownerOccupied: true / false / null', () => {
  assert.equal(isOwnerOccupied('88 Example St # 3', 'Brooklyn', '88 EXAMPLE STREET', 'brooklyn'), true)
  assert.equal(isOwnerOccupied('88 Example St', 'Brooklyn', '9 777th St', 'Brooklyn'), false)
  assert.equal(isOwnerOccupied('88 Example St', 'Brooklyn', '88 Example St', 'Ridgewood'), false) // city differs
  assert.equal(isOwnerOccupied('88 Example St', 'Brooklyn', null, 'Brooklyn'), null)
  assert.equal(isOwnerOccupied('88 Example St', 'Brooklyn', '  ', null), null)
})

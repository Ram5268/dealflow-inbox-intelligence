// Brief 48 (PR 3, items 4.7 and 4.16b): lib/review/corrections.ts, the Review
// Queue's correction reader. It turns what was typed into the listing's column
// types, refuses anything else with a message that names the field, treats an
// emptied box as "remove this value", and gives a new category a plain new title. Pure:
// no database, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Category } from '@prisma/client'
import { CORRECTABLE_FIELDS, listingChanges, parseCorrections, titleForCategory } from '../corrections'

function parsed(raw: unknown) {
  const r = parseCorrections(raw)
  assert.ok(r.ok, `expected ${JSON.stringify(raw)} to be read, got: ${r.ok ? '' : r.error}`)
  return r.fields
}
function refused(raw: unknown, names: RegExp): string {
  const r = parseCorrections(raw)
  assert.ok(!r.ok, `expected ${JSON.stringify(raw)} to be refused, got ${JSON.stringify(r.ok && r.fields)}`)
  assert.match(r.error, names, `the message names the field: ${r.error}`)
  assert.ok(!r.error.includes('!') && !r.error.includes('—'), `calm, no "!" and no em-dash: ${r.error}`)
  return r.error
}

test('a price is read the way a broker types it', () => {
  const cases: Array<[unknown, number]> = [
    ['1250000', 1_250_000], ['1,250,000', 1_250_000], ['$1,250,000', 1_250_000], ['$ 1,250,000.00', 1_250_000],
    [' 1250000 ', 1_250_000], ['1.25M', 1_250_000], ['1.25m', 1_250_000], ['$1.25M', 1_250_000],
    ['1.1M', 1_100_000], ['2.5mm', 2_500_000], ['950k', 950_000], ['950K', 950_000], ['$950k', 950_000],
    ['3,500', 3_500], ['2.5k', 2_500], [1_250_000, 1_250_000],
  ]
  for (const [typed, want] of cases) {
    assert.deepEqual(parsed({ price: typed }), { price: want }, `price ${JSON.stringify(typed)}`)
  }
  assert.deepEqual(parsed({ minPrice: '900k', maxPrice: '$1.2M' }), { minPrice: 900_000, maxPrice: 1_200_000 })
})

test('anything else in a price box is refused with a message that names it', () => {
  for (const typed of [
    'about a million', '12a', '1.2.3', '1,25,000', '1250,000', '$', 'k', '1e6', 'NaN', 'Infinity', '1.25B',
    '1 250 000', '$1.25M+', '0x10', '1.25 million', 'x'.repeat(200),
    Number.NaN, Number.POSITIVE_INFINITY, true, {}, [1],
  ]) {
    refused({ price: typed }, /^Price /)
  }
  assert.match(refused({ price: '-950000' }, /^Price /), /negative/)
  assert.match(refused({ price: '-$100' }, /^Price /), /negative/)
  assert.match(refused({ price: -1 }, /^Price /), /negative/)
  // Outside the range the email reader already flags as a price problem (lib/ingestion/validator.ts).
  for (const typed of ['125000000000', '$250M', '100', '0', 1e12]) {
    assert.match(refused({ price: typed }, /^Price /), /between \$500 and \$100,000,000/)
  }
  refused({ maxPrice: 'lots' }, /^Maximum price /)
  refused({ minPrice: 'some' }, /^Minimum price /)
})

test('beds, baths, units and square feet are read as numbers, with whole or half steps where they apply', () => {
  const cases: Array<[Record<string, unknown>, Record<string, number>]> = [
    [{ beds: '3' }, { beds: 3 }], [{ beds: '2.5' }, { beds: 2.5 }], [{ beds: '3BR' }, { beds: 3 }],
    [{ beds: '3 br' }, { beds: 3 }], [{ beds: '3 beds' }, { beds: 3 }], [{ beds: '1 bedroom' }, { beds: 1 }],
    [{ beds: 'Studio' }, { beds: 0 }], [{ beds: 'studio' }, { beds: 0 }], [{ beds: '0' }, { beds: 0 }], [{ beds: 4 }, { beds: 4 }],
    [{ baths: '1.5' }, { baths: 1.5 }], [{ units: '3' }, { units: 3 }], [{ squareFeet: '2,400' }, { squareFeet: 2_400 }],
  ]
  for (const [raw, want] of cases) assert.deepEqual(parsed(raw), want, JSON.stringify(raw))

  for (const typed of ['three', '3.5.1', '$3', '3k', '2.3', '101', '-1', 'NaN', Number.NaN, 2.25]) refused({ beds: typed }, /^Beds /)
  assert.match(refused({ beds: '2.3' }, /^Beds /), /whole or half/)
  assert.match(refused({ beds: '-1' }, /^Beds /), /negative/)
  refused({ baths: '1.25' }, /^Baths /)
  assert.match(refused({ units: '2.5' }, /^Units /), /whole number/)
  refused({ units: '0' }, /^Units /)
  refused({ squareFeet: '2,400 sq ft' }, /^Square feet /)
  refused({ squareFeet: '99999999' }, /^Square feet /)
})

test('text is trimmed, must be text, and has a length limit', () => {
  assert.deepEqual(parsed({ address: '  88 Example Ave  ', neighborhood: 'Park Slope' }), { address: '88 Example Ave', neighborhood: 'Park Slope' })
  assert.match(refused({ address: 88 }, /^Address /), /text/)
  assert.match(refused({ neighborhood: 'x'.repeat(301) }, /^Neighborhood /), /300 characters/)
  assert.equal(parsed({ extractedSummary: 'y'.repeat(4000) }).extractedSummary?.length, 4000)
  refused({ extractedSummary: 'y'.repeat(4001) }, /^Summary /)
})

test('an emptied box, or null, removes that value; title, summary and category can\'t be emptied', () => {
  // The page sends only the boxes that were changed, and each starts out showing the current value.
  assert.deepEqual(parsed({ price: '', address: '   ', beds: null }), { price: null, address: null, beds: null })
  for (const field of ['category', 'extractedTitle', 'extractedSummary']) {
    for (const typed of ['', ' ', null]) assert.match(refused({ [field]: typed }, /^(Category|Title|Summary) /), /can't be left empty/)
  }
  assert.deepEqual(parsed({}), {})
  assert.deepEqual(parsed(null), {})
})

test('a category must be one of DealFlow\'s categories', () => {
  assert.deepEqual(parsed({ category: 'OFF_MARKET_SALE' }), { category: 'OFF_MARKET_SALE' })
  assert.deepEqual(parsed({ category: ' BUYER_ISO ' }), { category: 'BUYER_ISO' })
  for (const typed of ['off_market_sale', 'MANSION', 'Off Market', 7, true]) refused({ category: typed }, /^Category /)
})

test('a field the Review Queue does not correct is refused by name', () => {
  for (const key of ['processingStatus', 'isTestData', 'organizationId', 'embedding', 'id', '__proto__']) {
    const raw = JSON.parse(`{"${key}": "x"}`) // JSON.parse keeps "__proto__" as a plain key
    assert.match(refused(raw, new RegExp(key)), /Review Queue/)
  }
  for (const raw of ['price=1', 42, [{ price: 1 }], true]) {
    const r = parseCorrections(raw)
    assert.ok(!r.ok, `${JSON.stringify(raw)} is refused`)
  }
})

test('every correctable field is a real listing column of the right type', () => {
  const schema = readFileSync(join(__dirname, '..', '..', '..', 'prisma', 'schema.prisma'), 'utf8')
  const model = /\nmodel ExtractedOpportunity \{\n([\s\S]*?)\n\}/.exec(schema)?.[1] ?? ''
  const columns = new Map<string, string>()
  for (const line of model.split('\n')) {
    const m = /^ {2}(\w+) +(\w+)/.exec(line)
    if (m) columns.set(m[1], m[2])
  }
  assert.ok(columns.size > 40, 'the model was read')
  const types: Record<string, string[]> = { text: ['String'], money: ['Float'], count: ['Float', 'Int'], category: ['Category'] }
  for (const [field, rule] of Object.entries(CORRECTABLE_FIELDS)) {
    const type = columns.get(field)
    assert.ok(type, `${field} is an ExtractedOpportunity column`)
    assert.ok(types[rule.kind].includes(type), `${field} is ${type}, read as ${rule.kind}`)
    if (type === 'Int') assert.equal('step' in rule && rule.step, 1, `${field} is an Int, so whole numbers only`)
  }
  // The same 16 fields the route has always allowed; `status` is the listing's own status column.
  assert.deepEqual(Object.keys(CORRECTABLE_FIELDS).sort(), [
    'address', 'availabilityDate', 'baths', 'beds', 'borough', 'category', 'extractedSummary', 'extractedTitle',
    'maxPrice', 'minPrice', 'neighborhood', 'price', 'propertyType', 'squareFeet', 'status', 'units',
  ])
})

test('a new title is the category label, the place, and the beds when known', () => {
  assert.equal(titleForCategory('ACTIVE_SALE_LISTING', { address: '88 Example Ave', neighborhood: 'Park Slope', beds: 3 }), 'Active Listing · 88 Example Ave · 3BR')
  assert.equal(titleForCategory('BUYER_ISO', { address: null, neighborhood: 'Park Slope', beds: null }), 'Buyer ISO · Park Slope')
  assert.equal(titleForCategory('RENTAL_LISTING', { address: '  ', neighborhood: 'Park Slope', beds: 0 }), 'Rental · Park Slope · Studio')
  assert.equal(titleForCategory('COMING_SOON_SALE', { address: '12 Sample St', beds: 2.5 }), 'Coming Soon (Sale) · 12 Sample St · 2.5BR')
  assert.equal(titleForCategory('NOISE', {}), 'Noise')
  for (const c of Object.values(Category)) {
    const t = titleForCategory(c, { address: '88 Example Ave', beds: 1 })
    assert.ok(!t.includes('—') && !t.includes('!'), t)
  }
})

test('a category change brings a new title unless the correction gives one', () => {
  const current = { category: 'OFF_MARKET_SALE' as Category, address: '88 Example Ave', neighborhood: 'Park Slope', beds: 2 }
  assert.deepEqual(listingChanges(current, { category: 'ACTIVE_SALE_LISTING' }),
    { category: 'ACTIVE_SALE_LISTING', extractedTitle: 'Active Listing · 88 Example Ave · 2BR' })
  assert.deepEqual(listingChanges(current, { category: 'RENTAL_LISTING', address: '12 Sample St', beds: 0 }),
    { category: 'RENTAL_LISTING', address: '12 Sample St', beds: 0, extractedTitle: 'Rental · 12 Sample St · Studio' })
  assert.deepEqual(listingChanges(current, { category: 'BUYER_ISO', extractedTitle: 'Given title' }), { category: 'BUYER_ISO', extractedTitle: 'Given title' })
  assert.deepEqual(listingChanges(current, { category: 'OFF_MARKET_SALE', price: 1_250_000 }), { category: 'OFF_MARKET_SALE', price: 1_250_000 })
  assert.deepEqual(listingChanges(current, { price: 1_250_000 }), { price: 1_250_000 })
  // A removed address isn't put back in the new title: the neighborhood stands in.
  assert.deepEqual(listingChanges(current, { category: 'ACTIVE_SALE_LISTING', address: null, beds: null }),
    { category: 'ACTIVE_SALE_LISTING', address: null, beds: null, extractedTitle: 'Active Listing · Park Slope' })
})

// Brief 43 PR 7: search_listings correctness (Q11, Q12, Q13, Q40; N6, N12).
// drift-1's p3 probe cases as regressions, on a stand-in for Prisma that
// evaluates the where clause the tool builds (pr7FakeDb.ts). Fictional
// addresses only. No database, no network.
import { fakeDb, lastQuery } from './pr7FakeDb'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchListings, type SearchListingsInput } from '../searchListings'

delete process.env.TEST_MODE_ONLY

type Row = Record<string, unknown>
const ORG = 'org-pr7'
const T0 = Date.UTC(2026, 9, 1)
let n = 0
// createdAt: an hour older per row, unless the case sets it.
function listing(over: Row = {}): Row {
  n++
  return {
    id: `L${n}`, organizationId: ORG, category: 'ACTIVE_SALE_LISTING', isDuplicate: false, processingStatus: 'active',
    extractedTitle: `Listing ${n}`, address: `${n} Sample St`, neighborhood: 'Crown Heights', neighborhoods: [], borough: null,
    beds: 3, minBeds: null, maxBeds: null, price: 1_000_000, minPrice: null, maxPrice: null, isTestData: true,
    units: null, propertyType: null, squareFeet: null, availabilityDate: null, sourceBrokerage: null,
    createdAt: new Date(T0 - n * 3_600_000), ...over,
  }
}
function load(rows: Row[]) {
  fakeDb.reset({ organization: [{ id: ORG, slug: 'dealflow-ryan' }], extractedOpportunity: rows })
}
async function search(input: SearchListingsInput) {
  return searchListings(input)
}
const prices = (r: Awaited<ReturnType<typeof search>>) => r.cards.map(c => c.price)
const hoods = (r: Awaited<ReturnType<typeof search>>) => r.cards.map(c => c.neighborhood)

test('L-02 / N6: "under $1.5M" is a hard ceiling ($1,550,000 is excluded)', async () => {
  load([1_450_000, 1_500_000, 1_550_000, 1_575_000, null].map(price => listing({ price })))
  const r = await search({ neighborhoods: ['Crown Heights'], priceMax: 1_500_000 })
  assert.deepEqual(prices(r), [1_450_000, 1_500_000])
  assert.equal(r.totalMatched, 2)
})

test('"over $X" is a hard floor', async () => {
  load([1_400_000, 1_500_000, 1_600_000].map(price => listing({ price })))
  const r = await search({ priceMin: 1_500_000 })
  assert.deepEqual(prices(r), [1_500_000, 1_600_000])
})

test('a stretch applies only when asked for (priceTolerance), as for "close fits"', async () => {
  load([1_500_000, 1_550_000, 1_800_000].map(price => listing({ price })))
  const r = await search({ priceMax: 1_500_000, priceTolerance: 0.15 })
  assert.deepEqual(prices(r), [1_500_000, 1_550_000])
  assert.ok((r.cards[1].priceOverlapScore ?? 1) < 1)
})

test('L-08: 2BR rentals in Williamsburg under 5k: $5,200 and East Williamsburg are excluded', async () => {
  load([
    ...[4_900, 5_000, 5_200, 5_250].map(price => listing({ neighborhood: 'Williamsburg', category: 'RENTAL_LISTING', price, beds: 2 })),
    listing({ neighborhood: 'East Williamsburg', category: 'RENTAL_LISTING', price: 4_500, beds: 2 }),
  ])
  const r = await search({ neighborhoods: ['Williamsburg'], intent: 'rental', beds: 2, priceMax: 5_000 })
  assert.deepEqual(prices(r), [4_900, 5_000])
  assert.deepEqual([...new Set(hoods(r))], ['Williamsburg'])
})

test('an area means that area: Harlem is not East Harlem, Flatbush is not East Flatbush', async () => {
  load([
    listing({ neighborhood: 'Harlem' }), listing({ neighborhood: 'East Harlem' }),
    listing({ neighborhood: 'Flatbush' }), listing({ neighborhood: 'East Flatbush' }),
  ])
  assert.deepEqual(hoods(await search({ neighborhoods: ['Harlem'] })), ['Harlem'])
  assert.deepEqual(hoods(await search({ neighborhoods: ['Flatbush'] })), ['Flatbush'])
  assert.deepEqual(hoods(await search({ neighborhoods: ['East Flatbush'] })), ['East Flatbush'])
})

test('spellings of the same area still match (Bed-Stuy, Bedford-Stuyvesant, Stuyvesant Heights)', async () => {
  load([
    listing({ neighborhood: 'Bed-Stuy' }), listing({ neighborhood: 'Stuyvesant Heights' }),
    listing({ neighborhood: 'bedford-stuyvesant' }), listing({ neighborhood: 'Bushwick' }),
  ])
  const r = await search({ neighborhoods: ['bedstuy'] })
  assert.deepEqual(hoods(r), ['Bed-Stuy', 'Stuyvesant Heights', 'bedford-stuyvesant'])
})

test('nearby: true adds the areas next door (East Williamsburg for Williamsburg)', async () => {
  load([
    listing({ neighborhood: 'Williamsburg' }), listing({ neighborhood: 'East Williamsburg' }), listing({ neighborhood: 'Astoria' }),
  ])
  assert.deepEqual(hoods(await search({ neighborhoods: ['Williamsburg'], nearby: true })), ['Williamsburg', 'East Williamsburg'])
})

test('L-04: "88 Example Ave" is that address only (not 188 Example Ave, not 88 Example St)', async () => {
  load([
    listing({ address: '88 Example Ave', category: 'RENTAL_LISTING', price: 3_600 }),
    listing({ address: '88 Example St' }),
    listing({ address: '188 Example Ave' }),
    listing({ address: '88 Example Avenue, Brooklyn, NY 11216' }),
    listing({ address: '88 Example Ave #3B' }),
    listing({ address: '288 Example Ave Apt 2' }),
  ])
  const r = await search({ address: '88 Example Ave' })
  assert.deepEqual(r.cards.map(c => c.address), ['88 Example Ave', '88 Example Avenue, Brooklyn, NY 11216', '88 Example Ave #3B'])
})

test('L-04: a shortened "88 Example" still never matches 188', async () => {
  load([listing({ address: '188 Example Ave' }), listing({ address: '88 Example St' }), listing({ address: '88 Example Ave' })])
  const r = await search({ address: '88 Example' })
  assert.deepEqual(r.cards.map(c => c.address), ['88 Example St', '88 Example Ave'])
})

test('L-04: the exact address comes first', async () => {
  // A row with more street words than asked comes after the exact one.
  load([listing({ address: '12 Sample Street South' }), listing({ address: '12 Sample St' })])
  const r = await search({ address: '12 Sample Street' })
  assert.deepEqual(r.cards.map(c => c.address), ['12 Sample St', '12 Sample Street South'])
})

test('L-04: an address search still reaches a listing older than the newest 500', async () => {
  const filler = Array.from({ length: 600 }, (_, i) => listing({ address: `${i + 1000} Sample St`, createdAt: new Date(T0 - i) }))
  load([...filler, listing({ address: '88 Example Ave', createdAt: new Date(T0 - 10 ** 10) })])
  const r = await search({ address: '88 Example Ave' })
  assert.deepEqual(r.cards.map(c => c.address), ['88 Example Ave'])
})

test('L-05 / Q12: a condo is excluded for "2-3 family"', async () => {
  load([
    listing({ neighborhood: 'Bedford-Stuyvesant', price: 900_000, propertyType: 'Condo', units: 1, extractedTitle: '1BR condo' }),
    listing({ neighborhood: 'Bedford-Stuyvesant', price: 1_850_000, propertyType: 'Townhouse', units: 3, extractedTitle: '3-family' }),
    listing({ neighborhood: 'Bedford-Stuyvesant', price: 1_700_000, propertyType: 'Two Family', units: null, extractedTitle: '2-family' }),
    listing({ neighborhood: 'Bedford-Stuyvesant', price: 1_600_000, propertyType: null, units: null, extractedTitle: 'unknown type' }),
    listing({ neighborhood: 'Bedford-Stuyvesant', price: 1_900_000, propertyType: 'Multi-Family', units: 6, extractedTitle: '6 units' }),
  ])
  const byUnits = await search({ neighborhoods: ['Bed-Stuy'], intent: 'sale', priceMax: 2_000_000, unitsMin: 2, unitsMax: 3 })
  assert.deepEqual(byUnits.cards.map(c => c.title), ['3-family', '2-family'])
  const byType = await search({ neighborhoods: ['Bed-Stuy'], intent: 'sale', propertyTypes: ['multifamily'] })
  assert.deepEqual(byType.cards.map(c => c.title), ['3-family', '2-family', '6 units'])
  const condos = await search({ neighborhoods: ['Bed-Stuy'], propertyTypes: ['condo'] })
  assert.deepEqual(condos.cards.map(c => c.title), ['1BR condo'])
})

test('Q12 / T-02: cards carry units, type, square feet, timeline and source when on file', async () => {
  load([
    listing({ propertyType: '3 Family', units: 3, squareFeet: 3_300, availabilityDate: 'Spring 2027', sourceBrokerage: 'Example Realty' }),
    listing({}),
  ])
  const r = await search({ neighborhoods: ['Crown Heights'] })
  const [full, bare] = r.cards
  assert.equal(full.units, 3)
  assert.equal(full.propertyType, '3 Family')
  assert.equal(full.squareFeet, 3_300)
  assert.equal(full.availabilityDate, 'Spring 2027')
  assert.equal(full.sourceBrokerage, 'Example Realty')
  for (const k of ['units', 'propertyType', 'squareFeet', 'availabilityDate', 'sourceBrokerage'] as const) assert.equal(bare[k], null, k)
})

// "around 3 mil" in Park Slope. createdAt is set so recency would give a different order.
function parkSlope() {
  const at = (h: number) => new Date(T0 - h * 3_600_000)
  load([
    listing({ neighborhood: 'Park Slope', price: 2_000_000, createdAt: at(1) }),
    listing({ neighborhood: 'Park Slope', price: 2_470_000, createdAt: at(2) }),
    listing({ neighborhood: 'Park Slope', price: 2_600_000, createdAt: at(3) }),
    listing({ neighborhood: 'Park Slope', price: 3_450_000, createdAt: at(4) }),
    listing({ neighborhood: 'Park Slope', price: 2_900_000, createdAt: at(5) }),
    listing({ neighborhood: 'Park Slope', price: 3_100_000, createdAt: at(6) }),
    listing({ neighborhood: 'Park Slope', price: 3_000_000, createdAt: at(7) }),
    listing({ neighborhood: 'Park Slope', price: 3_620_000, createdAt: at(8) }),
    listing({ neighborhood: 'Park Slope', price: 4_500_000, createdAt: at(9) }),
  ])
}

test('L-03 / Q40: "around 3M" (priceAround) is roughly 2.55M-3.45M, closest to 3M first, ties newest first', async () => {
  parkSlope()
  const r = await search({ neighborhoods: ['Park Slope'], priceAround: 3_000_000 })
  assert.deepEqual(prices(r), [3_000_000, 2_900_000, 3_100_000, 2_600_000, 3_450_000])
})

test('L-03 / Q40: "around 3M" sent as a range sorts closest to the middle first', async () => {
  parkSlope()
  const r = await search({ neighborhoods: ['Park Slope'], priceMin: 2_600_000, priceMax: 3_450_000 })
  // middle 3,025,000: 3.0M (25k), 3.1M (75k), 2.9M (125k), then 2.6M and 3.45M (425k each; 2.6M is newer)
  assert.deepEqual(prices(r), [3_000_000, 3_100_000, 2_900_000, 2_600_000, 3_450_000])
})

test('"under $X" keeps newest first among listings in range', async () => {
  parkSlope()
  const r = await search({ neighborhoods: ['Park Slope'], priceMax: 3_000_000 })
  assert.deepEqual(prices(r), [2_000_000, 2_470_000, 2_600_000, 2_900_000, 3_000_000])
})

test('N12: an older listing in the neighborhood is found among 600 newer ones', async () => {
  const filler = Array.from({ length: 600 }, (_, i) => listing({ neighborhood: 'Astoria', price: 900_000, createdAt: new Date(T0 - i) }))
  load([...filler, listing({ neighborhood: 'Tribeca', category: 'COMING_SOON_SALE', price: 5_000_000, createdAt: new Date(T0 - 10 ** 10) })])
  const r = await search({ neighborhoods: ['Tribeca'] })
  assert.deepEqual(hoods(r), ['Tribeca'])
  // The area filter ran in the database, not on a newest-500 pool.
  assert.equal(lastQuery('extractedOpportunity').returned, 1)
})

test('N12: price and beds filters run in the database too', async () => {
  const filler = Array.from({ length: 600 }, (_, i) => listing({ price: 900_000, beds: 1, createdAt: new Date(T0 - i) }))
  const old = (over: Row) => listing({ createdAt: new Date(T0 - 10 ** 10), ...over })
  load([...filler, old({ price: 3_000_000, beds: 1, extractedTitle: 'old 3M' }), old({ price: 900_000, beds: 4, extractedTitle: 'old 4BR' })])
  const byPrice = await search({ priceMin: 2_900_000, priceMax: 3_100_000 })
  assert.deepEqual(byPrice.cards.map(c => c.title), ['old 3M'])
  assert.equal(lastQuery('extractedOpportunity').returned, 1)
  const byBeds = await search({ bedsMin: 4 })
  assert.deepEqual(byBeds.cards.map(c => c.title), ['old 4BR'])
  assert.equal(lastQuery('extractedOpportunity').returned, 1)
})

test('listings stored as ranges still match (price "from X to Y", beds min-max)', async () => {
  load([
    listing({ price: null, minPrice: 2_800_000, maxPrice: 3_200_000, extractedTitle: 'range 2.8-3.2M' }),
    listing({ price: null, minPrice: 3_500_000, maxPrice: 3_900_000, extractedTitle: 'range 3.5-3.9M' }),
    listing({ price: null, minPrice: null, maxPrice: 3_050_000, extractedTitle: 'max only 3.05M' }),
    listing({ beds: null, minBeds: 2, maxBeds: 4, extractedTitle: 'beds 2-4' }),
    listing({ beds: null, minBeds: null, maxBeds: null, extractedTitle: 'beds unknown' }),
    listing({ beds: 1, extractedTitle: 'beds 1' }),
  ])
  const byPrice = await search({ priceMin: 2_900_000, priceMax: 3_100_000 })
  assert.deepEqual(byPrice.cards.map(c => c.title), ['range 2.8-3.2M', 'max only 3.05M'])
  const byBeds = await search({ beds: 3 })
  assert.deepEqual(byBeds.cards.map(c => c.title).filter(t => t.startsWith('beds')), ['beds 2-4', 'beds unknown'])
})

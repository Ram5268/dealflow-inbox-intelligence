// Brief 48 (PR 3, items 4.7 and 4.16b): PATCH /api/review, the Review Queue's
// Approve / Correct / Reject / Duplicate / Stale, on an in-memory stand-in for
// Prisma (no database, no network). A correction is turned into the listing's
// column types before anything is written; a refused correction writes nothing;
// the listing is saved before the item leaves the queue, in one transaction, so
// a failed save leaves the item pending; a new category gets a plain new title.
// Runs under tsx. Every row is invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { Category } from '@prisma/client'

type Row = Record<string, unknown>

const ITEM = 'rqi_b48_1'
const LISTING = 'opp_b48_1'

// The stand-in refuses what Prisma 7.8 refuses (messages copied from it): text in a
// Float column, a category outside the Category enum, and a row that isn't there.
const FLOAT_COLUMNS = new Set(['price', 'minPrice', 'maxPrice', 'beds', 'baths', 'units', 'squareFeet'])
const CATEGORIES = new Set<unknown>(Object.values(Category))
const notFound = () => Object.assign(new Error('No record was found for an update.'), { code: 'P2025' })

let items = new Map<string, Row>()
let listings = new Map<string, Row>()
let log: string[] = []          // every write, in order, and whether it ran in a transaction
let listingWrites: Row[] = []   // what each listing update was handed, before any check
let failListingWrite: Error | null = null
let failItemWrite: Error | null = null
let inTransaction = false

const baseListing = (): Row => ({
  id: LISTING, category: 'OFF_MARKET_SALE', address: '88 Example Ave', neighborhood: 'Park Slope',
  price: 999_000, beds: 2, baths: 1, units: null, extractedTitle: 'Off-market 2BR near the park',
  extractedSummary: 'A made-up two-bedroom.', processingStatus: 'needs_review', isDuplicate: false,
})
const baseItem = (opportunityId: string | null = LISTING): Row => ({
  id: ITEM, opportunityId, rawEmailId: 'raw_b48_1', flagReason: 'price_sanity', status: 'pending',
  reviewedAt: null, reviewNotes: null, userCorrectedFields: null,
})

function seed({ listing = baseListing() as Row | null, item = baseItem() } = {}) {
  items = new Map([[ITEM, item]])
  listings = new Map(listing ? [[LISTING, listing]] : [])
  log = []
  listingWrites = []
  failListingWrite = null
  failItemWrite = null
}

const copy = (r: Row | undefined) => (r ? structuredClone(r) : null)
const pick = (r: Row | undefined, select?: Record<string, boolean>) =>
  !r ? null : select ? Object.fromEntries(Object.keys(select).map(k => [k, r[k]])) : structuredClone(r)

const fakePrisma: Row = {
  reviewQueueItem: {
    findUnique: async ({ where }: { where: { id: string } }) => copy(items.get(where.id)),
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      log.push(`reviewQueueItem.update${inTransaction ? ' (in transaction)' : ''}`)
      if (failItemWrite) throw failItemWrite
      const row = items.get(where.id)
      if (!row) throw notFound()
      Object.assign(row, data)
      return copy(row)
    },
  },
  extractedOpportunity: {
    findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) =>
      pick(listings.get(where.id), select),
    update: async ({ where, data }: { where: { id: string }; data: Row }) => {
      log.push(`extractedOpportunity.update${inTransaction ? ' (in transaction)' : ''}`)
      listingWrites.push({ ...data })
      if (failListingWrite) throw failListingWrite
      for (const [k, v] of Object.entries(data)) {
        if (FLOAT_COLUMNS.has(k) && v !== null && typeof v !== 'number') {
          throw new Error(`Argument \`${k}\`: Invalid value provided. Expected Float, NullableFloatFieldUpdateOperationsInput or Null, provided String.`)
        }
        if (k === 'category' && !CATEGORIES.has(v)) throw new Error('Invalid value for argument `category`. Expected Category.')
      }
      const row = listings.get(where.id)
      if (!row) throw notFound()
      Object.assign(row, data)
      return copy(row)
    },
  },
  // The interactive form: if the callback throws, both tables go back to how they were.
  $transaction: async (fn: unknown) => {
    if (typeof fn !== 'function') throw new Error('stand-in: only the interactive $transaction form')
    const before = { items: structuredClone(items), listings: structuredClone(listings) }
    inTransaction = true
    try {
      return await (fn as (tx: unknown) => Promise<unknown>)(fakePrisma)
    } catch (e) {
      items = before.items
      listings = before.listings
      throw e
    } finally {
      inTransaction = false
    }
  },
  $executeRaw: async () => 0,
}
// lib/prisma uses globalThis.prisma when it is set, so no database client is created.
;(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma
// No network: the embedding step after an approve or a correct must never reach OpenAI.
globalThis.fetch = (async () => { throw new Error('network refused in tests') }) as typeof fetch

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { error, warn } = console
  console.error = () => {}
  console.warn = () => {}
  try { return await fn() } finally { console.error = error; console.warn = warn }
}

async function patch(body: unknown): Promise<{ status: number; body: Row }> {
  const { PATCH } = await import('../route')
  const req = new NextRequest('http://localhost/api/review', {
    method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  })
  try {
    const res = await quiet(() => PATCH(req))
    return { status: res.status, body: await res.json() as Row }
  } catch (e) {
    // Next.js answers an error thrown out of a route with a bare 500.
    return { status: 500, body: { thrown: (e as Error).message } }
  }
}

const listing = () => listings.get(LISTING) as Row
const item = () => items.get(ITEM) as Row

// A message for Ryan: plain words, calm, nothing from the database's own error.
function assertPlainMessage(message: unknown) {
  assert.equal(typeof message, 'string', 'an error message comes back')
  const m = message as string
  assert.ok(m.length > 0)
  assert.ok(!m.includes('!') && !m.includes('—'), `calm, no "!" and no em-dash: ${m}`)
  assert.ok(!/prisma|argument|invalid value|P2025|connection|stack/i.test(m), `no system words: ${m}`)
}

test('a price typed as text reaches the listing as a number and is stored', async () => {
  seed()
  const res = await patch({ id: ITEM, action: 'correct', corrections: { price: '1250000' } })
  const sent = listingWrites[0]?.price
  const what = `the listing update was handed price as a ${typeof sent} (${JSON.stringify(sent)}), ` +
    `the reply was ${res.status}, the listing's price is ${listing().price}, and the item is ${item().status}`
  assert.equal(typeof sent, 'number', what)
  assert.equal(res.status, 200, what)
  assert.equal(listing().price, 1_250_000)
  assert.equal(listing().processingStatus, 'active')
  assert.equal(item().status, 'corrected')
})

test('prices and beds typed the way a broker writes them are stored as numbers', async () => {
  const cases: Array<[Row, Row]> = [
    [{ price: '$1,250,000' }, { price: 1_250_000 }],
    [{ price: '1.25M' }, { price: 1_250_000 }],
    [{ price: '950k' }, { price: 950_000 }],
    [{ beds: '3' }, { beds: 3 }],
    [{ beds: 'Studio' }, { beds: 0 }],
  ]
  for (const [corrections, want] of cases) {
    seed()
    const res = await patch({ id: ITEM, action: 'correct', corrections })
    assert.equal(res.status, 200, `${JSON.stringify(corrections)}: ${JSON.stringify(res.body)}`)
    for (const [k, v] of Object.entries(want)) assert.equal(listing()[k], v, JSON.stringify(corrections))
  }
})

test('a bad number is refused with a message that names the field, and nothing is written', async () => {
  for (const [corrections, field] of [
    [{ price: 'about a million' }, /price/i],
    [{ price: '-950000' }, /price/i],
    [{ beds: 'three' }, /beds/i],
    [{ beds: '2.3' }, /beds/i],
  ] as Array<[Row, RegExp]>) {
    seed()
    const res = await patch({ id: ITEM, action: 'correct', corrections })
    assert.equal(res.status, 400, `${JSON.stringify(corrections)}: ${JSON.stringify(res.body)}`)
    assertPlainMessage(res.body.error)
    assert.match(res.body.error as string, field)
    assert.deepEqual(log, [], `${JSON.stringify(corrections)}: nothing is written`)
    assert.equal(item().status, 'pending', 'the item stays in the queue')
    assert.deepEqual(listing(), baseListing(), 'the listing is untouched')
  }
})

test('the item stays in the queue if the listing update fails', async () => {
  seed()
  failListingWrite = new Error('Connection terminated unexpectedly')
  const res = await patch({ id: ITEM, action: 'correct', corrections: { beds: '3' } })
  assert.equal(item().status, 'pending', `the item left the queue (status ${item().status}) though its listing wasn't saved`)
  assert.equal(res.status, 500)
  assertPlainMessage(res.body.error)
  assert.deepEqual(listing(), baseListing(), 'the listing is untouched')
})

test('the listing is saved before the item leaves the queue, in one transaction', async () => {
  seed()
  await patch({ id: ITEM, action: 'correct', corrections: { price: '1250000' } })
  assert.deepEqual(log, ['extractedOpportunity.update (in transaction)', 'reviewQueueItem.update (in transaction)'])
})

test('if closing the item fails, the listing change is rolled back', async () => {
  seed()
  failItemWrite = new Error('Connection terminated unexpectedly')
  const res = await patch({ id: ITEM, action: 'correct', corrections: { price: '1250000' } })
  assert.equal(res.status, 500)
  assertPlainMessage(res.body.error)
  assert.equal(listing().price, 999_000, 'the price change was rolled back')
  assert.equal(item().status, 'pending')
})

test('a category change sets a plain new title from the new category and the place', async () => {
  seed()
  const res = await patch({ id: ITEM, action: 'correct', corrections: { category: 'ACTIVE_SALE_LISTING' } })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(listing().category, 'ACTIVE_SALE_LISTING')
  assert.equal(listing().extractedTitle, 'Active Listing · 88 Example Ave · 2BR')
})

test('the new title uses the corrected address and beds; a title given with the change wins', async () => {
  seed()
  await patch({ id: ITEM, action: 'correct', corrections: { category: 'RENTAL_LISTING', address: '12 Sample St', beds: '0' } })
  assert.equal(listing().extractedTitle, 'Rental · 12 Sample St · Studio')

  seed()
  await patch({ id: ITEM, action: 'correct', corrections: { category: 'BUYER_ISO', extractedTitle: 'Buyer looking near the park' } })
  assert.equal(listing().extractedTitle, 'Buyer looking near the park')

  seed()
  await patch({ id: ITEM, action: 'correct', corrections: { category: 'OFF_MARKET_SALE', price: '1250000' } })
  assert.equal(listing().extractedTitle, 'Off-market 2BR near the park', 'the same category keeps the title')
})

test('a category DealFlow does not know is refused, and nothing is written', async () => {
  seed()
  const res = await patch({ id: ITEM, action: 'correct', corrections: { category: 'MANSION' } })
  assert.equal(res.status, 400, JSON.stringify(res.body))
  assertPlainMessage(res.body.error)
  assert.match(res.body.error as string, /category/i)
  assert.deepEqual(log, [])
  assert.equal(item().status, 'pending')
})

test('a field the Review Queue does not correct is refused, and nothing is written', async () => {
  for (const corrections of [{ processingStatus: 'active' }, { isTestData: false }, { organizationId: 'org_other' }]) {
    seed()
    const res = await patch({ id: ITEM, action: 'correct', corrections })
    assert.equal(res.status, 400, `${JSON.stringify(corrections)}: ${JSON.stringify(res.body)}`)
    assertPlainMessage(res.body.error)
    assert.deepEqual(log, [])
    assert.equal(item().status, 'pending')
  }
})

test('an emptied box removes that value (null, never an empty string), and the item records it', async () => {
  seed()
  const res = await patch({ id: ITEM, action: 'correct', corrections: { price: '', address: '   ', beds: '3' } })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(listing().price, null)
  assert.equal(listing().address, null)
  assert.equal(listing().beds, 3)
  assert.deepEqual(item().userCorrectedFields, { price: null, address: null, beds: 3 })
})

test('an emptied title is refused, and nothing is written', async () => {
  seed()
  const res = await patch({ id: ITEM, action: 'correct', corrections: { extractedTitle: '' } })
  assert.equal(res.status, 400, JSON.stringify(res.body))
  assertPlainMessage(res.body.error)
  assert.deepEqual(log, [])
  assert.equal(item().status, 'pending')
})

test('reject and duplicate still close the item and set the listing, with nothing to correct', async () => {
  seed()
  assert.equal((await patch({ id: ITEM, action: 'reject' })).status, 200)
  assert.equal(item().status, 'rejected')
  assert.equal(listing().processingStatus, 'rejected')

  seed()
  assert.equal((await patch({ id: ITEM, action: 'mark_duplicate' })).status, 200)
  assert.equal(item().status, 'marked_duplicate')
  assert.equal(listing().isDuplicate, true)
})

test('an item whose listing is gone can still be rejected, so it never sticks in the queue', async () => {
  seed({ listing: null })
  const res = await patch({ id: ITEM, action: 'reject' })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(item().status, 'rejected')
})

test('a correction on an item with no listing behind it is refused, and the item stays', async () => {
  for (const world of [{ listing: null }, { listing: null, item: baseItem(null) }]) {
    seed(world)
    const res = await patch({ id: ITEM, action: 'correct', corrections: { price: '1250000' } })
    assert.equal(res.status, 409, JSON.stringify(res.body))
    assertPlainMessage(res.body.error)
    assert.equal(item().status, 'pending')
    assert.deepEqual(log, [])
  }
})

test('an action the Review Queue does not know is refused, and the item stays', async () => {
  seed()
  const res = await patch({ id: ITEM, action: 'publish' })
  assert.equal(res.status, 400, JSON.stringify(res.body))
  assert.equal(item().status, 'pending')
  assert.deepEqual(log, [])
})

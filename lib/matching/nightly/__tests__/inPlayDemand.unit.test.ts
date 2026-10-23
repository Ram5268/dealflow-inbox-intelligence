// Must be the first import: it points lib/prisma at the in-memory stand-in.
import { BUYERS, MOJO_BUYER, current, isoBuyer, nightlyWorld, orgTables, type Tables } from './nightlyWorld'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Row } from '../../../__tests__/memoryDb'
import { runNightlyScoring } from '../runScoring'

// Brief 48 (PR 10, item 4.9): the nightly scores only buyer requests that are in
// play, the rule the app's other buyer lists use (isDuplicate false and
// processingStatus 'active'). A request marked duplicate, or still waiting in the
// Review Queue, used to count as a buyer: it took places in sellers' top 10, the
// call list ranked on it, and the CRM showed it as a matching buyer [planner's fix
// list, approved by Ryan 2026-10-19]. Rejected and stale requests (closed in the
// Review Queue), and requests read out of a sold comp, are left out the same way
// [engineering precaution]. Every buyer and seller here is invented.

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { warn, error } = console
  console.warn = () => {}
  console.error = () => {}
  try { return await fn() } finally { console.warn = warn; console.error = error }
}

async function night(tables: Partial<Tables>) {
  process.env.SCORING_INCLUDE_TEST_BUYERS = 'true' // the test-data phase, as in production
  current.world = nightlyWorld(tables)
  const result = (await quiet(() => runNightlyScoring())) as unknown as Row
  return { result, matches: current.world.data.match }
}

// Copies of real-looking buyers that must not count. Each would be eligible and
// score well against the sellers if it counted (same criteria as BUYERS[0..1]).
const DUPLICATE = isoBuyer('buyer-a-copy', { maxPrice: 1_600_000, isDuplicate: true, processingStatus: 'duplicate', duplicateOfId: 'buyer-a' })
const DUPLICATE_FLAG_ONLY = isoBuyer('buyer-b-copy', {
  minPrice: 1_200_000, maxPrice: 2_000_000, buyerArchetype: 'FIRST_TIME_FHA', isDuplicate: true, processingStatus: 'active',
})
const IN_REVIEW = isoBuyer('buyer-in-review', { maxPrice: 1_700_000, processingStatus: 'needs_review' })
const REJECTED = isoBuyer('buyer-rejected', { maxPrice: 1_700_000, processingStatus: 'rejected' })
const STALE = isoBuyer('buyer-stale', { maxPrice: 1_700_000, processingStatus: 'stale' })
const COMP = isoBuyer('buyer-comp', { maxPrice: 1_700_000, provenance: 'comp_reference' })
const RECOVERED = isoBuyer('buyer-recovered', { maxPrice: 1_700_000, provenance: 'buried_recovery' })
const counterparts = (matches: Row[]) => new Set(matches.map(m => m.counterpartId))

test('a buyer request marked duplicate is not scored', async () => {
  const { result, matches } = await night(orgTables({ extractedOpportunity: [...BUYERS, DUPLICATE, DUPLICATE_FLAG_ONLY] }))
  assert.equal(result.buyers, BUYERS.length + 1, 'the 4 buyer requests and the one Mojo buyer; neither copy')
  assert.equal(counterparts(matches).has('buyer-a-copy'), false)
  assert.equal(counterparts(matches).has('buyer-b-copy'), false)
})

test('a buyer request still waiting in the Review Queue is not scored', async () => {
  const { result, matches } = await night(orgTables({ extractedOpportunity: [...BUYERS, IN_REVIEW] }))
  assert.equal(result.buyers, BUYERS.length + 1)
  assert.equal(counterparts(matches).has('buyer-in-review'), false)
})

test('rejected and stale buyer requests are not scored either', async () => {
  const { result, matches } = await night(orgTables({ extractedOpportunity: [...BUYERS, REJECTED, STALE] }))
  assert.equal(result.buyers, BUYERS.length + 1)
  assert.equal(counterparts(matches).has('buyer-rejected'), false)
  assert.equal(counterparts(matches).has('buyer-stale'), false)
})

test('otherwise the night is the same as one without those requests', async () => {
  const withThem = await night(orgTables({ extractedOpportunity: [...BUYERS, DUPLICATE, DUPLICATE_FLAG_ONLY, IN_REVIEW, REJECTED, STALE] }))
  const without = await night(orgTables())
  const drop = (r: Row) => Object.fromEntries(Object.entries(r).filter(([k]) => !['ms', 'id', 'createdAt'].includes(k)))
  assert.deepEqual(drop(withThem.result), drop(without.result))
  const table = (rows: Row[]) => rows.map(drop).sort((a, b) =>
    `${a.opportunityId}|${a.counterpartId}`.localeCompare(`${b.opportunityId}|${b.counterpartId}`))
  assert.deepEqual(table(withThem.matches), table(without.matches))
  // The fixture really scores: every seller has a match, and the in-play buyers are all used.
  assert.equal(without.result.sellersCovered, without.result.sellers)
  assert.deepEqual([...counterparts(without.matches)].sort(), [...BUYERS.map(b => b.id), MOJO_BUYER.id].sort())
})

test('a request read out of a sold comp is not scored; a recovered one and a plain one are', async () => {
  const { result, matches } = await night(orgTables({ extractedOpportunity: [...BUYERS.map(b => ({ ...b, provenance: null })), COMP, RECOVERED] }))
  assert.equal(result.buyers, BUYERS.length + 2, 'the 4 plain requests, the recovered one and the Mojo buyer')
  assert.equal(counterparts(matches).has('buyer-comp'), false)
  assert.equal(counterparts(matches).has('buyer-recovered'), true)
})

test('the night after a request is marked duplicate or sent back to review, its old matches are deleted and the places refilled', async () => {
  process.env.SCORING_INCLUDE_TEST_BUYERS = 'true'
  const x = isoBuyer('buyer-x', { maxPrice: 1_700_000 })
  const y = isoBuyer('buyer-y', { maxPrice: 1_650_000, buyerArchetype: 'CASH_BUYER' })
  current.world = nightlyWorld(orgTables({ extractedOpportunity: [...BUYERS, x, y] }))
  await quiet(() => runNightlyScoring())
  const held = current.world.data.match.filter(m => m.counterpartId === 'buyer-x' || m.counterpartId === 'buyer-y').length
  assert.ok(held > 0, 'the two requests hold matches on night 1')
  for (const o of current.world.data.extractedOpportunity) {
    if (o.id === 'buyer-x') Object.assign(o, { isDuplicate: true, processingStatus: 'duplicate' })
    if (o.id === 'buyer-y') Object.assign(o, { processingStatus: 'needs_review' })
  }
  const second = (await quiet(() => runNightlyScoring())) as unknown as Row
  assert.equal(current.world.data.match.filter(m => m.counterpartId === 'buyer-x' || m.counterpartId === 'buyer-y').length, 0)
  assert.equal(second.deleted, held)
  const fresh = await night(orgTables())
  assert.equal(second.kept, fresh.result.kept)
})

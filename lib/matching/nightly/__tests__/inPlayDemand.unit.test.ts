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
// Review Queue) are left out the same way [engineering precaution]. Every buyer
// and seller here is invented.

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

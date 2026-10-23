// Brief 43 PR 14 (Q29, M21): search_listings and search_parties take
// createdAfter, so "what came in today / this week" is a real date filter, not
// a guess over the newest rows. A date alone means midnight in New York. Fake
// Prisma records the queries; no database, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEARCH_LISTINGS_TOOL, SEARCH_PARTIES_TOOL } from '../schemas'
import { RYAN_MD } from '../../../prompts/ryanMd'

type Q = { where?: Record<string, unknown> }
const queries: Array<{ model: string; args: Q }> = []
;(globalThis as unknown as { prisma: unknown }).prisma = {
  organization: { findUnique: async () => ({ id: 'org_pr14' }) },
  extractedOpportunity: { findMany: async (args: Q) => { queries.push({ model: 'opp', args }); return [] } },
  mojoContact: { findMany: async (args: Q) => { queries.push({ model: 'mojo', args }); return [] } },
}
globalThis.fetch = (async (u: unknown) => { throw new Error(`test: unexpected network call to ${String(u).split('?')[0]}`) }) as typeof fetch

const gte = (q: { args: Q }) => (q.args.where?.createdAt as { gte?: Date } | undefined)?.gte

test('createdAfterDate: a date alone is midnight in New York; a time is taken as given', async () => {
  const { createdAfterDate } = await import('../createdAfter')
  assert.equal(createdAfterDate('2026-10-19').toISOString(), '2026-10-19T04:00:00.000Z') // EDT
  assert.equal(createdAfterDate('2026-01-15').toISOString(), '2026-01-15T05:00:00.000Z') // EST
  assert.equal(createdAfterDate('2026-10-19T12:30:00Z').toISOString(), '2026-10-19T12:30:00.000Z')
  assert.equal(createdAfterDate('2026-10-19T08:00:00-04:00').toISOString(), '2026-10-19T12:00:00.000Z')
  // Review r1: a date-time with no zone is New York's clock, whatever the server's zone.
  assert.equal(createdAfterDate('2026-10-19T08:00').toISOString(), '2026-10-19T12:00:00.000Z') // EDT
  assert.equal(createdAfterDate('2026-10-19 08:00:00').toISOString(), '2026-10-19T12:00:00.000Z')
  assert.equal(createdAfterDate('2026-01-15T08:00:00').toISOString(), '2026-01-15T13:00:00.000Z') // EST
})

test('createdAfter must be an ISO date: loose phrases are refused', async () => {
  const { searchListingsInputSchema } = await import('../searchListings')
  const { searchPartiesInputSchema } = await import('../searchParties')
  for (const bad of ['friday at 3', 'last week', 'today', '10/19/2026', '2026-13-40', '']) {
    assert.equal(searchListingsInputSchema.safeParse({ createdAfter: bad }).success, false, bad)
    assert.equal(searchPartiesInputSchema.safeParse({ createdAfter: bad }).success, false, bad)
  }
  assert.equal(searchListingsInputSchema.safeParse({ createdAfter: '2026-10-12' }).success, true)
})

test('search_listings filters by createdAt in the database query', async () => {
  const { searchListings } = await import('../searchListings')
  queries.length = 0
  await searchListings({ createdAfter: '2026-10-12' })
  assert.equal(queries.length, 1)
  assert.equal(gte(queries[0])?.toISOString(), '2026-10-12T04:00:00.000Z')
  queries.length = 0
  await searchListings({})
  assert.equal(queries[0].args.where?.createdAt, undefined, 'no date filter unless asked')
})

test('search_parties filters by createdAt on every source it reads', async () => {
  const { searchParties } = await import('../searchParties')
  queries.length = 0
  await searchParties({ role: 'buyer', createdAfter: '2026-10-19' })
  assert.ok(queries.length >= 1)
  for (const q of queries) assert.equal(gte(q)?.toISOString(), '2026-10-19T04:00:00.000Z', q.model)
  queries.length = 0
  await searchParties({ createdAfter: '2026-10-19' })
  assert.ok(queries.length >= 1)
  for (const q of queries) assert.equal(gte(q)?.toISOString(), '2026-10-19T04:00:00.000Z', q.model)
  queries.length = 0
  await searchParties({ role: 'buyer' })
  for (const q of queries) assert.equal(q.args.where?.createdAt, undefined, q.model)
})

test('both tool schemas offer createdAfter, pointing at the TODAY line', () => {
  for (const tool of [SEARCH_LISTINGS_TOOL, SEARCH_PARTIES_TOOL]) {
    const p = (tool.input_schema.properties as Record<string, { type?: string; description?: string }>).createdAfter
    assert.ok(p, tool.name)
    assert.equal(p.type, 'string')
    assert.match(p.description ?? '', /TODAY/)
    assert.match(p.description ?? '', /New York/)
  }
})

test('RYAN_MD\'s inbox review uses createdAfter and says when email reading is paused', () => {
  const at = RYAN_MD.indexOf('INBOX REVIEW')
  const block = RYAN_MD.slice(at, RYAN_MD.indexOf('\n\n', at))
  assert.match(block, /createdAfter/)
  assert.match(block, /EMAIL note/)
  assert.doesNotMatch(block, /recent-date filter/)
})

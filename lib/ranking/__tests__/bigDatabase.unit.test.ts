import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import { loadMatchBuckets, persistBatch, queueMatchWhere, type QueueEntry, type QueueStats } from '../queueBuilder'

// Brief 48 (PR 14, item 4.12): the nightly call list at a bigger size. Postgres
// refuses a statement with more than 32,767 parameters. Prisma 7.8 splits a big
// insert or IN list on its own (measured on Postgres 18: 32,758 + 11,242 for a
// 4,000-row list), but that's Prisma's behaviour, not ours. These fakes refuse,
// like Postgres, any single call over the limit, so they show what our code asks
// for in one call [engineering precaution]. Every id here is invented.
const PG_MAX_PARAMS = 32_767
// Measured on Postgres 18 + Prisma 7.8: a CallQueueEntry row binds 11 parameters
// (the 9 fields persistBatch passes, plus the generated id and generatedAt).
const PARAMS_PER_CALL_LIST_ROW = 11

const tooMany = (n: number) => Object.assign(new Error(`${n} parameters: the query parameter limit supported by your database is exceeded`), { code: 'P2029' })

const stats: QueueStats = {
  totalContactsConsidered: 4_000, exclusionCounts: {}, queueLength: 4_000,
  priorityDistribution: { top10Avg: 90, top50Avg: 85, rank1Score: 95, rank50Score: 80, spread: 15 },
}
const entry = (i: number): QueueEntry => ({
  rank: i + 1, priorityScore: 95 - (i % 40), reason: 'Top 90-scored match', contactId: `seller-${i}`, primaryMatchId: `match-${i}`,
  contributingMatchIds: [`match-${i}-b`], contributions: { matchFitLift: 60 }, primaryMatch: null,
  contact: { id: `seller-${i}`, fullName: 'Pat Example', phone: null, neighborhood: null },
})

test('the call list is written in inserts that each stay under the parameter limit, delete first and log last (4,000 sellers)', () => {
  const calls: string[] = []
  const written: string[] = []
  const db = {
    callQueueEntry: {
      deleteMany: (a: unknown) => { calls.push('deleteMany'); return a },
      createMany: (a: { data: { contactId: string; rank: number }[] }) => {
        const params = a.data.length * PARAMS_PER_CALL_LIST_ROW
        if (params > PG_MAX_PARAMS) throw tooMany(params)
        calls.push(`createMany:${a.data.length}`)
        written.push(...a.data.map(r => `${r.rank}:${r.contactId}`))
        return a
      },
    },
    auditLog: { create: (a: { data: { action: string } }) => { calls.push(`audit:${a.data.action}`); return a } },
  } as unknown as Pick<PrismaClient, 'callQueueEntry' | 'auditLog'>
  const entries = Array.from({ length: 4_000 }, (_, i) => entry(i))

  const ops = persistBatch(db, 'org', entries, 'run-1', stats)

  assert.equal(calls[0], 'deleteMany')
  assert.equal(calls[calls.length - 1], 'audit:CALL_QUEUE_BUILD')
  const inserts = calls.slice(1, -1)
  assert.ok(inserts.length > 1 && inserts.every(c => c.startsWith('createMany:')), JSON.stringify(calls))
  // Every row once, in rank order; and all of it handed back as one list for one $transaction.
  assert.deepEqual(written, entries.map(e => `${e.rank}:${e.contactId}`))
  assert.equal(ops.length, calls.length)
})

test("the call list's dismissal check reads listing categories in calls under the limit, each listing once (66,000 inbox matches)", async () => {
  // 33,000 inbox listings, each matched with two Mojo buyers, plus one seller's match.
  // One dismissal on file: buyer-mojo-1 with listing 77, so that pair is skipped.
  const matches = [
    ...Array.from({ length: 33_000 }, (_, i) => ['buyer-mojo-1', 'buyer-mojo-2'].map(b => ({
      id: `m-${i}-${b}`, score: 60, matchFitConfidence: 'LOW', captureStatus: 'EXTERNAL_BOTH', createdAt: new Date('2026-10-20T09:00:00Z'),
      contributions: {}, opportunityId: `listing-${i}`, opportunityType: 'opportunity', counterpartId: b, counterpartType: 'mojo',
    }))).flat(),
    {
      id: 'm-seller', score: 90, matchFitConfidence: 'HIGH', captureStatus: 'EXTERNAL_BOTH', createdAt: new Date('2026-10-20T09:00:00Z'),
      contributions: { neighborhood: 40 }, opportunityId: 'seller-1', opportunityType: 'contact', counterpartId: 'buyer-iso-1', counterpartType: 'opportunity',
    },
  ]
  const fake = (cap: number) => {
    const asked: string[] = []
    const db = {
      match: { findMany: async () => matches },
      matchDismissal: { findMany: async () => [{ partyId: 'buyer-mojo-1', listingId: 'listing-77' }] },
      extractedOpportunity: {
        findMany: async (a: { where: { id: { in: string[] } } }) => {
          if (a.where.id.in.length > cap) throw tooMany(a.where.id.in.length)
          asked.push(...a.where.id.in)
          return a.where.id.in.map(id => ({ id, category: 'ACTIVE_SALE_LISTING' }))
        },
      },
    } as unknown as Pick<PrismaClient, 'match' | 'matchDismissal' | 'extractedOpportunity'>
    return { db, asked }
  }

  const capped = fake(PG_MAX_PARAMS)
  const buckets = await loadMatchBuckets(capped.db, queueMatchWhere('org'))

  assert.equal(new Set(capped.asked).size, 33_000)
  assert.equal(capped.asked.length, 33_000, 'each listing is asked for once')
  assert.equal(buckets.get('buyer-mojo-1')?.length, 32_999, 'the dismissed pair is skipped')
  assert.equal(buckets.get('buyer-mojo-1')?.some(m => m.id === 'm-77-buyer-mojo-1'), false)
  assert.equal(buckets.get('buyer-mojo-2')?.length, 33_000)
  assert.equal(buckets.get('seller-1')?.length, 1)
  // The same buckets as one unlimited read gives.
  const unlimited = await loadMatchBuckets(fake(Infinity).db, queueMatchWhere('org'))
  assert.deepEqual(buckets, unlimited)
})

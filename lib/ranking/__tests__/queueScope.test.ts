import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import { contactScopeWhere, persistBatch, type QueueEntry, type QueueStats } from '../queueBuilder'

// Brief 35: the nightly list ranks CRM sellers only, and persisting always
// replaces the org's list, even when it's empty.

test("scope 'crm' ranks only real CRM-sourced contacts; 'all' ranks the whole org", () => {
  assert.deepEqual(contactScopeWhere('org', 'crm'), {
    organizationId: 'org', isTestData: false, metadata: { path: ['source'], equals: 'crm' },
  })
  assert.deepEqual(contactScopeWhere('org', 'all'), { organizationId: 'org' })
})

const calls: string[] = []
const fakeDb = {
  callQueueEntry: {
    deleteMany: (a: unknown) => { calls.push('deleteMany'); return a },
    createMany: (a: { data: unknown[] }) => { calls.push(`createMany:${a.data.length}`); return a },
  },
  auditLog: { create: (a: { data: { action: string } }) => { calls.push(`audit:${a.data.action}`); return a } },
} as unknown as Pick<PrismaClient, 'callQueueEntry' | 'auditLog'>
const stats: QueueStats = {
  totalContactsConsidered: 3, exclusionCounts: { no_matches: 3 }, queueLength: 0,
  priorityDistribution: { top10Avg: 0, top50Avg: 0, rank1Score: 0, rank50Score: 0, spread: 0 },
}

test('an empty list still replaces the old one and is logged', () => {
  calls.length = 0
  persistBatch(fakeDb, 'org', [], 'run-1', stats)
  assert.deepEqual(calls, ['deleteMany', 'audit:CALL_QUEUE_BUILD'])
})

test('a non-empty list is deleted, inserted and logged', () => {
  calls.length = 0
  const entry = {
    rank: 1, priorityScore: 80, reason: 'r', contactId: 'c1', primaryMatchId: 'm1', contributingMatchIds: [],
    contributions: {}, contact: { id: 'c1', fullName: 'X', phone: null, neighborhood: null }, primaryMatch: null,
  } as QueueEntry
  persistBatch(fakeDb, 'org', [entry], 'run-1', { ...stats, queueLength: 1 })
  assert.deepEqual(calls, ['deleteMany', 'createMany:1', 'audit:CALL_QUEUE_BUILD'])
})

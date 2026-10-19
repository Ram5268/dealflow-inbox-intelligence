// Must be the first import: it points lib/prisma at the in-memory stand-in.
import { current } from '../../__tests__/globalMemoryDb'
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import { memoryDb } from '../../__tests__/memoryDb'
import {
  QUEUE_CONTACT_SELECT, buildCallQueue, contactScopeWhere, loadMatchBuckets, queueMatchWhere, rankContact,
  type QueueEntry,
} from '../queueBuilder'
import { FIXED_NOW, ORG, queueFixture } from './queueFixture'

// Brief 45 (PR E): the import-scoring route ranks a handful of new sellers with
// the same per-contact logic as the nightly call list (rankContact), reading
// only those sellers' matches (queueMatchWhere with ids). For every contact,
// that must give exactly what buildCallQueue gives it. No database.

async function nightly() {
  current.mem = memoryDb(queueFixture())
  return buildCallQueue(ORG, Infinity, false, { scope: 'crm' })
}

async function shared(onlyIds?: string[]) {
  const db = memoryDb(queueFixture()).db as unknown as PrismaClient
  const all = await db.mojoContact.findMany({ where: contactScopeWhere(ORG, 'crm'), select: QUEUE_CONTACT_SELECT })
  const contacts = onlyIds ? all.filter(c => onlyIds.includes(c.id)) : all
  const buckets = await loadMatchBuckets(db, queueMatchWhere(ORG, contacts.map(c => c.id)))
  const excluded: Record<string, number> = {}
  const entries = new Map<string, Omit<QueueEntry, 'rank'>>()
  for (const c of contacts) {
    const r = rankContact(c, buckets.get(c.id) ?? [], { now: new Date() })
    if (r.excluded) excluded[r.reason] = (excluded[r.reason] ?? 0) + 1
    else entries.set(c.id, r.entry)
  }
  return { excluded, entries }
}

test('rankContact over each contact\'s own matches = buildCallQueue, entry for entry and exclusion for exclusion', async () => {
  mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  try {
    const { entries, stats } = await nightly()
    const mine = await shared()
    assert.deepEqual(mine.excluded, stats.exclusionCounts)
    assert.equal(mine.entries.size, entries.length)
    for (const { rank: _rank, ...e } of entries) assert.equal(JSON.stringify(mine.entries.get(e.contactId)), JSON.stringify(e), e.contactId)
  } finally {
    mock.timers.reset()
  }
})

test('a few contacts at a time (the import path) get the same result as in the whole list', async () => {
  mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  try {
    const { entries } = await nightly()
    // c10 has a dismissed pair and more than 5 matches; c11 is the buyer side of a dismissed inbox pair; c06 has none.
    const some = await shared(['c06', 'c10', 'c11'])
    assert.deepEqual(some.excluded, { no_matches: 1 })
    for (const id of ['c10', 'c11']) {
      const { rank: _rank, ...e } = entries.find(x => x.contactId === id)!
      assert.equal(JSON.stringify(some.entries.get(id)), JSON.stringify(e), id)
    }
  } finally {
    mock.timers.reset()
  }
})

test('queueMatchWhere: the nightly reads every contact-involving match; with ids, only those contacts\' matches', () => {
  assert.deepEqual(queueMatchWhere('org'), { organizationId: 'org', OR: [{ opportunityType: 'contact' }, { counterpartType: 'mojo' }] })
  assert.deepEqual(queueMatchWhere('org', ['a', 'b']), {
    organizationId: 'org',
    OR: [{ opportunityType: 'contact', opportunityId: { in: ['a', 'b'] } }, { counterpartType: 'mojo', counterpartId: { in: ['a', 'b'] } }],
  })
})

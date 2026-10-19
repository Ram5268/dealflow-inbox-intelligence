// Must be the first import: it points lib/prisma at the in-memory stand-in.
import { SELLERS, MOJO_BUYER, crmSeller, current, nightlyWorld, orgTables, type Tables } from '../matching/nightly/__tests__/nightlyWorld'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Row } from './memoryDb'
import { runNightlyPipeline } from '../nightlyPipeline'
import { buildCallQueue } from '../ranking/queueBuilder'

// Brief 47 (PR 1): the nightly pipeline on the in-memory stand-in (no database).
//   • Scoring refused by its size check: the call-list step doesn't run, so
//     yesterday's call list stays, and the run fails (the cron route returns 500).
//   • Brief 46 DF-2: the call-list step never replaces the list with an empty one;
//     it keeps yesterday's, writes one AuditLog row and fails.
// Both are engineering precautions. The CRM lead sync (step 1) has no CRM to read
// here, so it fails in every run below; as before, that never stops the later steps.
delete process.env.DATABASE_URL_CRM_RO

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { warn, error } = console
  console.warn = () => {}
  console.error = () => {}
  try { return await fn() } finally { console.warn = warn; console.error = error }
}

// Yesterday's call list: three entries of one earlier run.
const YESTERDAY = SELLERS.slice(0, 3).map((s, i) => ({
  id: `cq-old-${i}`, organizationId: 'org-test', contactId: s.id, rank: i + 1, priorityScore: 70 - i, reason: 'an earlier night',
  primaryMatchId: null, contributingMatchIds: [], contributions: {}, generationRunId: 'run-yesterday', generatedAt: new Date('2026-10-18T09:00:00Z'),
}))

async function run(tables: Partial<Tables>, opts: { dryRun?: boolean; only?: 'callQueue'; testBuyers?: boolean; countFails?: boolean } = {}) {
  if (opts.testBuyers === false) delete process.env.SCORING_INCLUDE_TEST_BUYERS
  else process.env.SCORING_INCLUDE_TEST_BUYERS = 'true'
  current.world = nightlyWorld(tables, { countFails: opts.countFails })
  const before = structuredClone(current.world.data)
  const pipeline = await quiet(() => runNightlyPipeline({ dryRun: opts.dryRun, only: opts.only }))
  return { pipeline, world: current.world, before }
}
// The Match table a normal night leaves.
async function yesterdaysMatches() {
  const { world, pipeline } = await run(orgTables())
  assert.equal(pipeline.steps.scoring.ok, true)
  return world.data.match
}
const ops = (w: { writes: { op: string }[] }) => w.writes.map(x => x.op)
const actions = (w: { writes: { op: string; args: unknown }[] }) =>
  w.writes.filter(x => x.op === 'auditLog.create').map(x => (x.args as Row).action)

test('scoring refused: the call list is not rebuilt, yesterday\'s stays, and the run fails', async () => {
  const match = await yesterdaysMatches()
  const { pipeline, world, before } = await run(orgTables({ match, callQueueEntry: YESTERDAY }), { testBuyers: false })
  assert.equal(pipeline.ok, false)
  assert.deepEqual(pipeline.steps.crmLeadSync, { ok: false, error: 'DATABASE_URL_CRM_RO not set' })
  assert.deepEqual(pipeline.steps.scoring, { ok: false, error: 'scoring refused: no_buyers, matches_shrank, sellers_shrank' })
  assert.deepEqual(pipeline.steps.callQueue, { ok: false, error: 'skipped: scoring was refused' })
  assert.deepEqual(world.data.callQueueEntry, before.callQueueEntry)
  assert.deepEqual(world.data.match, before.match)
  assert.deepEqual(actions(world), ['NIGHTLY_SCORING_REFUSED'])
  // The call-list step never even read: no match or call-list call at all.
  assert.ok(!world.calls.some(c => c.op === 'match.findMany' || c.op.startsWith('callQueueEntry.')))
})

test('a normal night: scoring writes and the call list is rebuilt, as before', async () => {
  const { pipeline, world } = await run(orgTables({ callQueueEntry: YESTERDAY }))
  assert.equal(pipeline.steps.scoring.ok, true)
  assert.equal(pipeline.steps.callQueue.ok, true)
  assert.deepEqual(actions(world), ['NIGHTLY_SCORING', 'CALL_QUEUE_BUILD'])
  assert.ok(ops(world).includes('callQueueEntry.deleteMany') && ops(world).includes('callQueueEntry.createMany'))
  assert.ok(world.data.callQueueEntry.length > 0)
  assert.ok(world.data.callQueueEntry.every(e => e.generationRunId !== 'run-yesterday'))
})

test('scoring failing for another reason (a lost connection) still lets the call list run, as before', async () => {
  const match = await yesterdaysMatches()
  const { pipeline, world } = await run(orgTables({ match, callQueueEntry: YESTERDAY }), { countFails: true })
  assert.deepEqual(pipeline.steps.scoring, { ok: false, error: 'Connection terminated unexpectedly' })
  assert.equal(pipeline.steps.callQueue.ok, true)
  assert.deepEqual(actions(world), ['CALL_QUEUE_BUILD'])
})

test('a refused dry run writes nothing and skips the call list too', async () => {
  const match = await yesterdaysMatches()
  const { pipeline, world, before } = await run(orgTables({ match, callQueueEntry: YESTERDAY }), { dryRun: true, testBuyers: false })
  assert.equal(pipeline.ok, false)
  assert.equal(pipeline.steps.scoring.ok, false)
  assert.deepEqual(pipeline.steps.callQueue, { ok: false, error: 'skipped: scoring was refused' })
  assert.deepEqual(world.writes, [])
  assert.deepEqual(world.data, before)
})

test('only the call-list step still runs on its own', async () => {
  const match = await yesterdaysMatches()
  const { pipeline, world } = await run(orgTables({ match, callQueueEntry: YESTERDAY }), { only: 'callQueue' })
  assert.deepEqual(Object.keys(pipeline.steps), ['callQueue'])
  assert.equal(pipeline.ok, true)
  assert.deepEqual(actions(world), ['CALL_QUEUE_BUILD'])
})

// ── Brief 46 DF-2: never an empty call list ─────────────────────────────────

test('a call list with 0 entries keeps yesterday\'s: no delete, no insert, one refusal row, and it throws', async () => {
  current.world = nightlyWorld(orgTables({ callQueueEntry: YESTERDAY })) // no matches: every seller is left out
  const before = structuredClone(current.world.data)
  await assert.rejects(buildCallQueue('org-test', Infinity, true, { scope: 'crm' }),
    (e: Error) => e.name === 'CallQueueRefusedError' && e.message === 'call list refused: empty_list')
  assert.deepEqual(ops(current.world), ['auditLog.create'])
  assert.deepEqual(current.world.writes[0].args, {
    organizationId: 'org-test', action: 'CALL_QUEUE_BUILD_REFUSED',
    detailsJson: { reasons: ['empty_list'], totalContactsConsidered: SELLERS.length, exclusionCounts: { no_matches: SELLERS.length }, queueLength: 0 },
  })
  assert.deepEqual(current.world.data.callQueueEntry, before.callQueueEntry)
})

test('in the pipeline: scoring passes but every seller is left out of the list (do not call): yesterday\'s list stays', async () => {
  const dnc = SELLERS.map((s, i) => crmSeller(s.id as string, i, { neighborhood: s.neighborhood, status: 'Do Not Call' }))
  const { pipeline, world, before } = await run(orgTables({ mojoContact: [...dnc, MOJO_BUYER], callQueueEntry: YESTERDAY }))
  assert.equal(pipeline.steps.scoring.ok, true)
  assert.deepEqual(pipeline.steps.callQueue, { ok: false, error: 'call list refused: empty_list' })
  assert.equal(pipeline.ok, false)
  assert.deepEqual(world.data.callQueueEntry, before.callQueueEntry)
  assert.deepEqual(actions(world), ['NIGHTLY_SCORING', 'CALL_QUEUE_BUILD_REFUSED'])
})

test('ranking without saving (persist off) still returns an empty list and writes nothing', async () => {
  current.world = nightlyWorld(orgTables({ callQueueEntry: YESTERDAY }))
  const r = await buildCallQueue('org-test', Infinity, false, { scope: 'crm' })
  assert.deepEqual(r.entries, [])
  assert.equal(r.stats.queueLength, 0)
  assert.deepEqual(current.world.writes, [])
})

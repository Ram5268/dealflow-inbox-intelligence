import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import { handleImport, KEEP_PUBLISHED_RUNS } from '../importRun'
import { MAX_ROWS_PER_BATCH } from '../contract'
import { makeFakeDb, seedSellers, ORG, runInput, valuedRow, reasonRow, passingChecks, type FakeDb } from './fakeDb'

// Brief 44: POST /api/valuations/import's three steps against an in-memory database.

const N = 1500
const asPrisma = (db: FakeDb) => db as unknown as PrismaClient

function rowsFor(db: FakeDb, valuedCount = 1432) {
  const ids = db.mojoContact.rows.filter(r => (r.metadata as { source?: string }).source === 'crm' && !r.isTestData).map(r => r.id as string)
  return ids.map((id, i) => (i < valuedCount ? valuedRow(id) : reasonRow(id, i % 2 ? 'five_plus_units' : 'not_found')))
}

async function upload(db: FakeDb, runId: string, rows: ReturnType<typeof rowsFor>) {
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_BATCH) {
    const r = await handleImport(asPrisma(db), ORG, { action: 'rows', runId, rows: rows.slice(i, i + MAX_ROWS_PER_BATCH) })
    assert.equal(r.status, 200, JSON.stringify(r.body))
  }
}

async function fullRun(db: FakeDb, runId: string, at: Date, opts: { valued?: number } = {}) {
  const start = await handleImport(asPrisma(db), ORG, { action: 'start', run: runInput({ runId }) }, at)
  assert.equal(start.status, 200, JSON.stringify(start.body))
  await upload(db, runId, rowsFor(db, opts.valued))
  return handleImport(asPrisma(db), ORG, { action: 'publish', runId }, at)
}

test('start, rows in batches of 200, publish', async () => {
  const db = makeFakeDb(); seedSellers(db, N)
  const res = await fullRun(db, 'vr_20261020T100000Z_aaaaaa', new Date('2026-10-20T10:40:00Z'))
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.published, true)
  assert.equal(res.body.rows, N)
  assert.equal(res.body.valued, 1432)
  const run = db.valuationRun.rows[0]
  assert.equal(run.published, true)
  assert.ok(run.publishedAt instanceof Date)
  assert.equal(db.propertyValuation.rows.length, N)
  const pv = db.propertyValuation.rows[0]
  assert.equal(pv.organizationId, ORG)
  assert.equal((pv.asOf as Date).toISOString(), '2026-10-01T00:00:00.000Z')
})

test('re-sending any step is harmless', async () => {
  const db = makeFakeDb(); seedSellers(db, N)
  const runId = 'vr_20261020T100000Z_bbbbbb'
  await handleImport(asPrisma(db), ORG, { action: 'start', run: runInput({ runId }) })
  await handleImport(asPrisma(db), ORG, { action: 'start', run: runInput({ runId }) })
  assert.equal(db.valuationRun.rows.length, 1)
  const rows = rowsFor(db)
  await upload(db, runId, rows)
  await upload(db, runId, rows.slice(0, 400)) // a retried batch
  assert.equal(db.propertyValuation.rows.length, N, 'no duplicate rows')
  const first = await handleImport(asPrisma(db), ORG, { action: 'publish', runId })
  const again = await handleImport(asPrisma(db), ORG, { action: 'publish', runId })
  assert.equal(first.status, 200)
  assert.equal(again.status, 200)
  assert.equal(again.body.alreadyPublished, true)
})

test('a published run is frozen', async () => {
  const db = makeFakeDb(); seedSellers(db, N)
  const runId = 'vr_20261020T100000Z_cccccc'
  assert.equal((await fullRun(db, runId, new Date())).status, 200)
  const rows = await handleImport(asPrisma(db), ORG, { action: 'rows', runId, rows: [valuedRow('c0001')] })
  assert.equal(rows.status, 409)
  assert.equal(rows.body.error, 'already_published')
  const restart = await handleImport(asPrisma(db), ORG, { action: 'start', run: runInput({ runId }) })
  assert.equal(restart.status, 409)
})

test('rows need a started run and known CRM sellers', async () => {
  const db = makeFakeDb(); seedSellers(db, 10)
  const nope = await handleImport(asPrisma(db), ORG, { action: 'rows', runId: 'vr_20261020T100000Z_nonexist', rows: [valuedRow('c0001')] })
  assert.equal(nope.status, 404)
  const runId = 'vr_20261020T100000Z_dddddd'
  await handleImport(asPrisma(db), ORG, { action: 'start', run: runInput({ runId }) })
  for (const id of ['c_unknown', 'c_legacy', 'c_test']) {
    const r = await handleImport(asPrisma(db), ORG, { action: 'rows', runId, rows: [valuedRow('c0001'), valuedRow(id)] })
    assert.equal(r.status, 422, id)
    assert.equal(r.body.unknown, 1)
  }
  const dup = await handleImport(asPrisma(db), ORG, { action: 'rows', runId, rows: [valuedRow('c0001'), valuedRow('c0001')] })
  assert.equal(dup.status, 400)
  assert.equal(db.propertyValuation.rows.length, 0, 'a refused batch writes nothing')
})

test('bad rows are refused without echoing their contents', async () => {
  const db = makeFakeDb(); seedSellers(db, 10)
  const runId = 'vr_20261020T100000Z_eeeeee'
  await handleImport(asPrisma(db), ORG, { action: 'start', run: runInput({ runId }) })
  const bad = { ...valuedRow('c0001'), facts: { ...valuedRow('c0001').facts, ownerName: 'Secret Person' } }
  const r = await handleImport(asPrisma(db), ORG, { action: 'rows', runId, rows: [bad] })
  assert.equal(r.status, 400)
  assert.ok(!JSON.stringify(r.body).includes('Secret Person'))
  assert.equal(db.propertyValuation.rows.length, 0)
})

test('publish refuses a run whose gates fail, even if it says they passed', async () => {
  const db = makeFakeDb(); seedSellers(db, N)
  const runId = 'vr_20261020T100000Z_ffffff'
  const checks = passingChecks().map(c => (c.key === 'typical_miss_top8_2to4' ? { ...c, value: 0.151 } : c))
  const start = await handleImport(asPrisma(db), ORG, { action: 'start', run: runInput({ runId, gates: { passed: true, checks } }) })
  assert.equal(start.body.gatesPassed, false)
  await upload(db, runId, rowsFor(db))
  const pub = await handleImport(asPrisma(db), ORG, { action: 'publish', runId })
  assert.equal(pub.status, 409)
  assert.equal(pub.body.error, 'gates_failed')
  assert.equal(db.valuationRun.rows[0].published, false)
})

test('publish refuses a partial upload or too few values', async () => {
  const db = makeFakeDb(); seedSellers(db, N)
  const runId = 'vr_20261020T100000Z_gggggg'
  await handleImport(asPrisma(db), ORG, { action: 'start', run: runInput({ runId }) })
  await upload(db, runId, rowsFor(db).slice(0, 1400))
  const partial = await handleImport(asPrisma(db), ORG, { action: 'publish', runId })
  assert.equal(partial.status, 409)
  assert.equal(partial.body.error, 'row_count_mismatch')
  const db2 = makeFakeDb(); seedSellers(db2, N)
  const few = await fullRun(db2, 'vr_20261020T100000Z_hhhhhh', new Date(), { valued: 1299 })
  assert.equal(few.status, 409)
  assert.equal(few.body.error, 'too_few_valued')
})

test('values of the 12 newest published runs are kept; the newest published run is never removed', async () => {
  const db = makeFakeDb(); seedSellers(db, N)
  const at = (m: number) => new Date(Date.UTC(2026, m, 20, 10, 40))
  for (let m = 0; m < KEEP_PUBLISHED_RUNS + 2; m++) {
    const res = await fullRun(db, `vr_run_month_${String(m).padStart(2, '0')}`, at(m))
    assert.equal(res.status, 200, JSON.stringify(res.body))
  }
  const kept = new Set(db.propertyValuation.rows.map(r => r.runId))
  assert.equal(kept.size, KEEP_PUBLISHED_RUNS)
  assert.ok(!kept.has('vr_run_month_00') && !kept.has('vr_run_month_01'))
  assert.ok(kept.has(`vr_run_month_${KEEP_PUBLISHED_RUNS + 1}`))
  assert.equal(db.valuationRun.rows.length, KEEP_PUBLISHED_RUNS + 2, 'run records are never deleted')
  // A later run that fails its gates leaves the published values alone.
  const failRun = 'vr_run_failing_01'
  const checks = passingChecks().map(c => (c.key === 'range_coverage' ? { ...c, value: 0.8 } : c))
  await handleImport(asPrisma(db), ORG, { action: 'start', run: runInput({ runId: failRun, gates: { passed: false, checks } }) })
  assert.equal(new Set(db.propertyValuation.rows.map(r => r.runId)).size, KEEP_PUBLISHED_RUNS)
})

test('an abandoned upload is cleared at the next publish', async () => {
  const db = makeFakeDb(() => new Date('2026-09-01T10:00:00Z')); seedSellers(db, N)
  const stale = 'vr_20260901T100000Z_stale1'
  await handleImport(asPrisma(db), ORG, { action: 'start', run: runInput({ runId: stale }) })
  await upload(db, stale, rowsFor(db).slice(0, 200))
  const res = await fullRun(db, 'vr_20261020T100000Z_fresh1', new Date('2026-10-20T10:40:00Z'))
  assert.equal(res.status, 200)
  assert.equal(res.body.prunedRows, 200)
  assert.ok(!db.propertyValuation.rows.some(r => r.runId === stale))
})

test('another organization cannot touch a run', async () => {
  const db = makeFakeDb(); seedSellers(db, 10)
  const runId = 'vr_20261020T100000Z_iiiiii'
  await handleImport(asPrisma(db), ORG, { action: 'start', run: runInput({ runId }) })
  const r = await handleImport(asPrisma(db), 'org_other', { action: 'start', run: runInput({ runId }) })
  assert.equal(r.status, 409)
  const p = await handleImport(asPrisma(db), 'org_other', { action: 'publish', runId })
  assert.equal(p.status, 404)
})

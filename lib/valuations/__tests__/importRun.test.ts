import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import { handleImport, KEEP_PUBLISHED_RUNS } from '../importRun'
import { MAX_ROWS_PER_BATCH } from '../contract'
import {
  makeFakeDb, seedSellers, settle, ORG, NOW, runInput, runAt, valuedRow, reasonRow, passingChecks, facts, comp, type FakeDb,
} from './fakeDb'

// Brief 44: POST /api/valuations/import's three steps against an in-memory database.

const N = 1500
const asPrisma = (db: FakeDb) => db as unknown as PrismaClient
const send = (db: FakeDb, payload: unknown, now = NOW) => handleImport(asPrisma(db), ORG, payload, now)

const crmIds = (db: FakeDb) =>
  db.mojoContact.rows.filter(r => (r.metadata as { source?: string }).source === 'crm' && !r.isTestData).map(r => r.id as string)

function rowsFor(db: FakeDb, valuedCount = 1432, ids = crmIds(db)) {
  return ids.map((id, i) => (i < valuedCount ? valuedRow(id) : reasonRow(id, i % 2 ? 'five_plus_units' : 'not_found')))
}

async function upload(db: FakeDb, runId: string, rows: ReturnType<typeof rowsFor>, now = NOW) {
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_BATCH) {
    const r = await send(db, { action: 'rows', runId, rows: rows.slice(i, i + MAX_ROWS_PER_BATCH) }, now)
    assert.equal(r.status, 200, JSON.stringify(r.body))
  }
}

async function fullRun(db: FakeDb, runId: string, at: Date, opts: { valued?: number; run?: Record<string, unknown> } = {}) {
  const start = await send(db, { action: 'start', run: runAt(at, { runId, ...opts.run }) }, at)
  assert.equal(start.status, 200, JSON.stringify(start.body))
  await upload(db, runId, rowsFor(db, opts.valued), at)
  return send(db, { action: 'publish', runId }, at)
}

const failingChecks = () => passingChecks().map(c => (c.key === 'range_coverage' ? { ...c, value: 0.9 } : c))

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
  assert.equal((await send(db, { action: 'start', run: runInput({ runId }) })).status, 200)
  assert.equal((await send(db, { action: 'start', run: runInput({ runId }) })).status, 200)
  assert.equal(db.valuationRun.rows.length, 1)
  const rows = rowsFor(db)
  await upload(db, runId, rows)
  await upload(db, runId, rows.slice(0, 400)) // a retried batch
  assert.equal(db.propertyValuation.rows.length, N, 'no duplicate rows')
  assert.equal((await send(db, { action: 'start', run: runInput({ runId }) })).status, 200, 'an unchanged start after rows')
  const first = await send(db, { action: 'publish', runId })
  const again = await send(db, { action: 'publish', runId })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(again.status, 200)
  assert.equal(again.body.alreadyPublished, true)
})

test('a published run is frozen', async () => {
  const db = makeFakeDb(); seedSellers(db, N)
  const runId = 'vr_20261020T100000Z_cccccc'
  assert.equal((await fullRun(db, runId, NOW)).status, 200)
  const rows = await send(db, { action: 'rows', runId, rows: [valuedRow('c0001')] })
  assert.equal(rows.status, 409)
  assert.equal(rows.body.error, 'already_published')
  const restart = await send(db, { action: 'start', run: runAt(NOW, { runId }) })
  assert.equal(restart.status, 409)
  assert.equal(restart.body.error, 'already_published')
})

test('rows need a started run and known CRM sellers', async () => {
  const db = makeFakeDb(); seedSellers(db, 10)
  const nope = await send(db, { action: 'rows', runId: 'vr_20261020T100000Z_nonexist', rows: [valuedRow('c0001')] })
  assert.equal(nope.status, 404)
  const runId = 'vr_20261020T100000Z_dddddd'
  await send(db, { action: 'start', run: runInput({ runId }) })
  for (const id of ['c_unknown', 'c_legacy', 'c_test']) {
    const r = await send(db, { action: 'rows', runId, rows: [valuedRow('c0001'), valuedRow(id)] })
    assert.equal(r.status, 422, id)
    assert.equal(r.body.error, 'unknown_contacts')
    assert.deepEqual(r.body.unknown, [id], 'names the refused ids')
  }
  const dup = await send(db, { action: 'rows', runId, rows: [valuedRow('c0001'), valuedRow('c0001')] })
  assert.equal(dup.status, 400)
  assert.equal(db.propertyValuation.rows.length, 0, 'a refused batch writes nothing')
})

test('sellers the CRM sync dropped after targets were fetched are named, so the run drops them and still publishes', async () => {
  const db = makeFakeDb(); seedSellers(db, 1400)
  const runId = 'vr_20261020T100000Z_recov1'
  const ids = crmIds(db)
  assert.equal((await send(db, { action: 'start', run: runInput({ runId, expectedRows: ids.length }) })).status, 200)
  // The nightly sync marks two of them removed / duplicate.
  const meta = (id: string) => db.mojoContact.rows.find(r => r.id === id)!
  meta('c0005').metadata = { source: 'crm_removed' }
  meta('c0150').metadata = { source: 'duplicate', duplicateOf: 'c0001' }
  const first = await send(db, { action: 'rows', runId, rows: rowsFor(db, 1400, ids.slice(0, 200)) })
  assert.equal(first.status, 422)
  assert.deepEqual(first.body.unknown, ['c0005', 'c0150'])
  assert.equal(db.propertyValuation.rows.length, 0)
  // The job drops them, re-sends start with the smaller count, and goes on.
  const kept = ids.filter(id => id !== 'c0005' && id !== 'c0150')
  assert.equal((await send(db, { action: 'start', run: runInput({ runId, expectedRows: kept.length }) })).status, 200)
  await upload(db, runId, rowsFor(db, 1350, kept))
  const pub = await send(db, { action: 'publish', runId })
  assert.equal(pub.status, 200, JSON.stringify(pub.body))
  assert.equal(pub.body.rows, 1398)
})

test('bad rows are refused without echoing their contents', async () => {
  const db = makeFakeDb(); seedSellers(db, 10)
  const runId = 'vr_20261020T100000Z_eeeeee'
  await send(db, { action: 'start', run: runInput({ runId }) })
  const bad = { ...valuedRow('c0001'), facts: { ...facts(), ownerName: 'Secret Person' } }
  const r = await send(db, { action: 'rows', runId, rows: [bad] })
  assert.equal(r.status, 400)
  assert.ok(!JSON.stringify(r.body).includes('Secret Person'))
  assert.ok(!JSON.stringify(r.body).includes('ownerName'))
  assert.equal(db.propertyValuation.rows.length, 0)
})

test('a nearby sale or a last sale on or after the run’s as-of day is refused', async () => {
  const db = makeFakeDb(); seedSellers(db, 10)
  const runId = 'vr_20261020T100000Z_dated1'
  await send(db, { action: 'start', run: runInput({ runId, asOf: '2026-10-01', dataThrough: '2026-09-30' }) })
  const withComp = (date: string) => ({ ...valuedRow('c0001'), comps: [comp(0), { ...comp(1), date }] })
  const withSale = (date: string) => ({ ...valuedRow('c0002'), facts: { ...facts(), lastSale: { date, price: 610000 } } })
  for (const row of [withComp('2026-10-01'), withComp('2026-10-02'), withSale('2026-10-01'), withSale('2027-01-01')]) {
    const r = await send(db, { action: 'rows', runId, rows: [valuedRow('c0000'), row] })
    assert.equal(r.status, 400, JSON.stringify(row))
    assert.equal(r.body.error, 'invalid_payload')
    const where = JSON.stringify(r.body.issues)
    assert.ok(/rows\.1\.(comps\.1|facts\.lastSale)\.date/.test(where), where)
    assert.ok(!where.includes('2026-10-0') && !where.includes('2027'), 'the date itself is not echoed')
  }
  assert.equal(db.propertyValuation.rows.length, 0)
  const ok = await send(db, { action: 'rows', runId, rows: [withComp('2026-09-30'), withSale('2026-09-30')] })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
})

test('a run’s time must be recent and its as-of day not in the future', async () => {
  const db = makeFakeDb()
  const start = (run: Record<string, unknown>, now = NOW) => send(db, { action: 'start', run: runInput({ runId: 'vr_20261020T100000Z_times1', ...run }) }, now)
  const minutes = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString()
  assert.equal((await start({ runAt: minutes(11) })).status, 400, 'more than 10 minutes ahead')
  assert.equal((await start({ runAt: minutes(-7 * 24 * 60 - 1) })).status, 400, 'more than 7 days ago')
  assert.equal((await start({ runAt: '2099-01-01T00:00:00Z' })).status, 400)
  assert.equal(db.valuationRun.rows.length, 0)
  assert.equal((await start({ runAt: minutes(9) })).status, 200)
  assert.equal((await start({ runAt: minutes(-7 * 24 * 60 + 1) })).status, 200)
  const day = new Date('2026-10-20T23:00:00Z') // the server's UTC day is the 20th
  assert.equal((await start({ runAt: '2026-10-20T22:55:00Z', asOf: '2026-10-22', dataThrough: '2026-10-01' }, day)).status, 400, 'asOf the day after tomorrow')
  assert.equal((await start({ runAt: '2026-10-20T22:55:00Z', asOf: '2026-10-21', dataThrough: '2026-10-01' }, day)).status, 200, 'asOf tomorrow (UTC)')
})

test('once rows are in, asOf, dataThrough and modelVersion are frozen; the counts, gates and blobs may still change', async () => {
  const db = makeFakeDb(); seedSellers(db, 10)
  const runId = 'vr_20261020T100000Z_frozen'
  const start = (over: Record<string, unknown>) => send(db, { action: 'start', run: runInput({ runId, expectedRows: 10, ...over }) })
  assert.equal((await start({})).status, 200)
  // Before any rows, a start may still change them.
  assert.equal((await start({ asOf: '2026-09-01', dataThrough: '2026-08-31' })).status, 200)
  assert.equal((await start({})).status, 200)
  assert.equal((await send(db, { action: 'rows', runId, rows: [valuedRow('c0000')] })).status, 200)
  for (const over of [{ asOf: '2026-10-02' }, { dataThrough: '2026-09-29' }, { modelVersion: 'dealflow-gbm90-v2' }]) {
    const r = await start(over)
    assert.equal(r.status, 409, JSON.stringify(over))
    assert.equal(r.body.error, 'run_frozen')
  }
  const run = () => db.valuationRun.rows[0]
  assert.equal((run().asOf as Date).toISOString().slice(0, 10), '2026-10-01')
  assert.equal(run().modelVersion, 'dealflow-gbm90-v1')
  const changed = await start({
    expectedRows: 9, gates: { passed: false, checks: failingChecks() }, metrics: { all: { n: 1 } }, scoreboard: null, sources: null,
    counts: { ...runInput().counts, targets: 9 },
  })
  assert.equal(changed.status, 200, JSON.stringify(changed.body))
  assert.equal(changed.body.gatesPassed, false)
  assert.equal(run().expectedRows, 9)
  assert.equal(run().gatesPassed, false)
  assert.deepEqual(run().metricsJson, { all: { n: 1 } })
  assert.equal((run().countsJson as { targets: number }).targets, 9)
})

test('publish refuses a run whose gates fail, even if it says they passed', async () => {
  const db = makeFakeDb(); seedSellers(db, N)
  const runId = 'vr_20261020T100000Z_ffffff'
  const checks = passingChecks().map(c => (c.key === 'typical_miss_top8_2to4' ? { ...c, value: 0.151 } : c))
  const start = await send(db, { action: 'start', run: runInput({ runId, gates: { passed: true, checks } }) })
  assert.equal(start.body.gatesPassed, false)
  await upload(db, runId, rowsFor(db))
  const pub = await send(db, { action: 'publish', runId })
  assert.equal(pub.status, 409)
  assert.equal(pub.body.error, 'gates_failed')
  assert.equal(db.valuationRun.rows[0].published, false)
})

test('publish refuses a partial upload or too few values', async () => {
  const db = makeFakeDb(); seedSellers(db, N)
  const runId = 'vr_20261020T100000Z_gggggg'
  await send(db, { action: 'start', run: runInput({ runId }) })
  await upload(db, runId, rowsFor(db).slice(0, 1400))
  const partial = await send(db, { action: 'publish', runId })
  assert.equal(partial.status, 409)
  assert.equal(partial.body.error, 'row_count_mismatch')
  const db2 = makeFakeDb(); seedSellers(db2, N)
  const few = await fullRun(db2, 'vr_20261020T100000Z_hhhhhh', NOW, { valued: 1299 })
  assert.equal(few.status, 409)
  assert.equal(few.body.error, 'too_few_valued')
})

test('publish refuses rows dated differently from their run', async () => {
  const db = makeFakeDb(); seedSellers(db, N)
  const runId = 'vr_20261020T100000Z_asof01'
  await send(db, { action: 'start', run: runInput({ runId }) })
  await upload(db, runId, rowsFor(db))
  db.propertyValuation.rows[7].asOf = new Date('2026-09-01T00:00:00Z') // however it got there
  const pub = await send(db, { action: 'publish', runId })
  assert.equal(pub.status, 409)
  assert.equal(pub.body.error, 'as_of_mismatch')
  assert.equal(db.valuationRun.rows[0].published, false)
})

test('publish refuses a run older than one already published', async () => {
  const db = makeFakeDb(); seedSellers(db, N)
  assert.equal((await fullRun(db, 'vr_20261020T100000Z_newer1', NOW)).status, 200)
  const older = await fullRun(db, 'vr_20261020T100000Z_older1', NOW, { run: { asOf: '2026-09-01', dataThrough: '2026-08-31' } })
  assert.equal(older.status, 409)
  assert.equal(older.body.error, 'older_than_published')
  assert.equal(db.valuationRun.rows.find(r => r.id === 'vr_20261020T100000Z_older1')!.published, false)
  // The same as-of day again (a re-run of the month) may publish.
  assert.equal((await fullRun(db, 'vr_20261020T100000Z_again1', NOW)).status, 200)
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
  const later = at(KEEP_PUBLISHED_RUNS + 2)
  const fail = await send(db, { action: 'start', run: runAt(later, { runId: 'vr_run_failing_01', gates: { passed: false, checks: failingChecks() } }) }, later)
  assert.equal(fail.status, 200)
  assert.equal(new Set(db.propertyValuation.rows.map(r => r.runId)).size, KEEP_PUBLISHED_RUNS)
})

test('pruning counts a published run with no publish time as the oldest, never the newest', async () => {
  const db = makeFakeDb(); seedSellers(db, N)
  // However it got there: a published run without a publish time, and its rows.
  db.valuationRun.rows.push({
    id: 'vr_no_time_0001', organizationId: ORG, published: true, publishedAt: null, runAt: new Date('2025-12-20T10:00:00Z'),
    asOf: new Date('2025-12-01T00:00:00Z'), dataThrough: new Date('2025-11-30T00:00:00Z'), modelVersion: 'old', gatesPassed: true,
    createdAt: new Date('2025-12-20T10:00:00Z'), updatedAt: new Date('2025-12-20T10:00:00Z'),
  })
  db.propertyValuation.rows.push({ id: 'pv_old', runId: 'vr_no_time_0001', organizationId: ORG, contactId: 'c0000', bbl: '3000000001', createdAt: new Date('2025-12-20T10:00:00Z') })
  const at = (m: number) => new Date(Date.UTC(2026, m, 20, 10, 40))
  for (let m = 0; m < KEEP_PUBLISHED_RUNS; m++) {
    assert.equal((await fullRun(db, `vr_run_month_${String(m).padStart(2, '0')}`, at(m))).status, 200)
  }
  const kept = new Set(db.propertyValuation.rows.map(r => r.runId))
  assert.ok(!kept.has('vr_no_time_0001'), 'the run without a publish time is pruned first')
  assert.equal(kept.size, KEEP_PUBLISHED_RUNS, 'all 12 real runs keep their values')
})

test('an abandoned upload is cleared at the next publish, once it is more than 2 days old', async () => {
  const db = makeFakeDb(() => new Date('2026-09-01T10:00:00Z')); seedSellers(db, N)
  const stale = 'vr_20260901T100000Z_stale1'
  const sept = new Date('2026-09-01T10:30:00Z')
  await send(db, { action: 'start', run: runAt(sept, { runId: stale }) }, sept)
  await upload(db, stale, rowsFor(db).slice(0, 200), sept)
  const res = await fullRun(db, 'vr_20261020T100000Z_fresh1', new Date('2026-10-20T10:40:00Z'))
  assert.equal(res.status, 200)
  assert.equal(res.body.prunedRows, 200)
  assert.ok(!db.propertyValuation.rows.some(r => r.runId === stale))
})

test('another organization cannot touch a run', async () => {
  const db = makeFakeDb(); seedSellers(db, 10)
  const runId = 'vr_20261020T100000Z_iiiiii'
  await send(db, { action: 'start', run: runInput({ runId }) })
  const r = await handleImport(asPrisma(db), 'org_other', { action: 'start', run: runInput({ runId }) }, NOW)
  assert.equal(r.status, 409)
  assert.equal(r.body.error, 'run_id_taken')
  const rows = await handleImport(asPrisma(db), 'org_other', { action: 'rows', runId, rows: [valuedRow('c0001')] }, NOW)
  assert.equal(rows.status, 404)
  const p = await handleImport(asPrisma(db), 'org_other', { action: 'publish', runId }, NOW)
  assert.equal(p.status, 404)
})

// The lock-ordering tests. Each holds one request right after its first call on
// the run and sends another meanwhile. Whatever the order, a published run must be
// one whose gates passed, with every row it was checked against.
function assertPublishedRunIsSound(db: FakeDb) {
  for (const run of db.valuationRun.rows) {
    if (!run.published) continue
    assert.equal(run.gatesPassed, true, `${run.id} is published with failing gates`)
    const rows = db.propertyValuation.rows.filter(r => r.runId === run.id).length
    assert.equal(rows, run.expectedRows, `${run.id} is published with ${rows} rows but expects ${run.expectedRows}`)
  }
}

test('a re-sent start while a publish is under way waits, then is refused: it never rewrites the published run', async () => {
  const db = makeFakeDb(); seedSellers(db, N)
  const runId = 'vr_20261020T100000Z_race01'
  await send(db, { action: 'start', run: runInput({ runId }) })
  await upload(db, runId, rowsFor(db))
  const pause = db.pauseAfter(op => op.table === 'valuationRun')
  const publishing = send(db, { action: 'publish', runId })
  await pause.reached
  const restarting = send(db, { action: 'start', run: runInput({ runId, gates: { passed: false, checks: failingChecks() }, expectedRows: 1400 }) })
  await settle()
  pause.release()
  const [pub, restart] = await Promise.all([publishing, restarting])
  assertPublishedRunIsSound(db)
  assert.equal(pub.status, 200, JSON.stringify(pub.body))
  assert.equal(restart.status, 409)
  assert.equal(restart.body.error, 'already_published')
})

test('a publish while a re-sent start is under way waits for it, then decides on the run as the start left it', async () => {
  const db = makeFakeDb(); seedSellers(db, N)
  const runId = 'vr_20261020T100000Z_race02'
  await send(db, { action: 'start', run: runInput({ runId }) })
  await upload(db, runId, rowsFor(db))
  const pause = db.pauseAfter(op => op.table === 'valuationRun')
  const restarting = send(db, { action: 'start', run: runInput({ runId, gates: { passed: false, checks: failingChecks() } }) })
  await pause.reached
  const publishing = send(db, { action: 'publish', runId })
  await settle()
  pause.release()
  const [restart, pub] = await Promise.all([restarting, publishing])
  assertPublishedRunIsSound(db)
  assert.equal(restart.status, 200, JSON.stringify(restart.body))
  assert.equal(pub.status, 409)
  assert.equal(pub.body.error, 'gates_failed')
  assert.equal(db.valuationRun.rows[0].published, false)
})

test('a batch while a publish is under way waits, then is refused', async () => {
  const db = makeFakeDb(); seedSellers(db, N)
  const runId = 'vr_20261020T100000Z_race03'
  await send(db, { action: 'start', run: runInput({ runId }) })
  const rows = rowsFor(db)
  await upload(db, runId, rows)
  const pause = db.pauseAfter(op => op.table === 'valuationRun')
  const publishing = send(db, { action: 'publish', runId })
  await pause.reached
  const batch = send(db, { action: 'rows', runId, rows: rows.slice(0, 200).map(r => ({ ...r, value: null, low: null, high: null, reason: 'five_plus_units', comps: [] })) })
  await settle()
  pause.release()
  const [pub, late] = await Promise.all([publishing, batch])
  assertPublishedRunIsSound(db)
  assert.equal(pub.status, 200, JSON.stringify(pub.body))
  assert.equal(late.status, 409)
  assert.equal(db.propertyValuation.rows.filter(r => r.value != null).length, 1432, 'the published values are untouched')
})

test('two starts creating the same run at once: one creates it, the other is told to retry', async () => {
  const db = makeFakeDb()
  const runId = 'vr_20261020T100000Z_race04'
  const pause = db.pauseAfter(op => op.table === 'valuationRun' && op.method === 'findUnique')
  const first = send(db, { action: 'start', run: runInput({ runId, expectedRows: 11 }) })
  await pause.reached
  const second = await send(db, { action: 'start', run: runInput({ runId, expectedRows: 22 }) })
  pause.release()
  const late = await first
  assert.equal(second.status, 200)
  assert.equal(late.status, 409)
  assert.equal(late.body.error, 'retry')
  assert.equal(db.valuationRun.rows.length, 1)
  assert.equal(db.valuationRun.rows[0].expectedRows, 22)
})

test('every write transaction waits at most 10 s for the run and runs at most 30 s', async () => {
  const db = makeFakeDb(); seedSellers(db, N)
  assert.equal((await fullRun(db, 'vr_20261020T100000Z_limits', NOW)).status, 200)
  assert.ok(db.txOptions.length >= 3)
  for (const o of db.txOptions) assert.deepEqual(o, { maxWait: 10_000, timeout: 30_000 })
})

test('two runs publishing at once take turns: the older month never ends up latest', async () => {
  const db = makeFakeDb(); seedSellers(db, N)
  const prep = async (runId: string, asOf: string, dataThrough: string) => {
    assert.equal((await send(db, { action: 'start', run: runInput({ runId, asOf, dataThrough }) })).status, 200)
    await upload(db, runId, rowsFor(db))
  }
  await prep('vr_20261020T100000Z_month10', '2026-10-01', '2026-09-30')
  await prep('vr_20261020T100000Z_month09', '2026-09-01', '2026-08-31')
  // October's publish is held just after its "is a newer month published?" read...
  const pause = db.pauseAfter(op => op.table === 'valuationRun' && op.method === 'findFirst')
  const october = send(db, { action: 'publish', runId: 'vr_20261020T100000Z_month10' }, new Date(NOW.getTime() + 60_000))
  await pause.reached
  // ...while September's publish arrives a second later.
  const september = send(db, { action: 'publish', runId: 'vr_20261020T100000Z_month09' }, new Date(NOW.getTime() + 61_000))
  await settle()
  pause.release()
  const [oct, sep] = await Promise.all([october, september])
  assert.equal(oct.status, 200, JSON.stringify(oct.body))
  assert.equal(sep.status, 409, JSON.stringify(sep.body))
  assert.equal(sep.body.error, 'older_than_published')
  assert.deepEqual(db.valuationRun.rows.filter(r => r.published).map(r => r.id), ['vr_20261020T100000Z_month10'])
})

test('a publish that arrives while the run’s first start is still being written is told to retry, never "already published"', async () => {
  const db = makeFakeDb(); seedSellers(db, 10)
  const runId = 'vr_20261020T100000Z_early1'
  const creating = db.pauseAfter(op => op.table === 'valuationRun' && op.method === 'findUnique')
  const start = send(db, { action: 'start', run: runInput({ runId, expectedRows: 10 }) })
  await creating.reached // the start found no run and is about to create it
  const locking = db.pauseAfter(op => op.table === 'valuationRun' && op.method === 'updateMany')
  const publish = send(db, { action: 'publish', runId })
  await locking.reached // the publish found no run to lock
  creating.release()
  assert.equal((await start).status, 200)
  locking.release()
  const pub = await publish
  assert.equal(pub.status, 409, JSON.stringify(pub.body))
  assert.equal(pub.body.error, 'retry')
  assert.equal(db.valuationRun.rows[0].published, false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import { buildTargets } from '../targets'
import { buildStatus } from '../status'
import { makeFakeDb, seedSellers, ORG, passingChecks, type FakeDb } from './fakeDb'

// Brief 44: what GET /api/valuations/targets (protected) and GET /api/valuations/status
// (public) read back, against an in-memory database. Runs and rows are planted
// directly, so these tests also cover stored data the import would never accept.

const asPrisma = (db: FakeDb) => db as unknown as PrismaClient
const at = (iso: string) => new Date(iso)
const COUNT_KEYS = ['condo_without_unit', 'five_plus_units', 'gateSales', 'not_found', 'other_property_type', 'targets', 'trainingSales', 'valued']
const RUN_KEYS = ['asOf', 'counts', 'dataThrough', 'gates', 'gatesPassed', 'modelVersion', 'published', 'publishedAt', 'runAt']

function plantRun(db: FakeDb, id: string, over: Record<string, unknown> = {}) {
  db.valuationRun.rows.push({
    id, organizationId: ORG, runAt: at('2026-10-20T10:00:00Z'), asOf: at('2026-10-01T00:00:00Z'), dataThrough: at('2026-09-30T00:00:00Z'),
    modelVersion: 'dealflow-gbm90-v1', gatesPassed: true, gatesJson: { reported: { passed: true, checks: passingChecks() } },
    metricsJson: { all: { n: 2800 } }, scoreboardJson: null, sourcesJson: null,
    countsJson: { targets: 3, valued: 3, five_plus_units: 0, condo_without_unit: 0, not_found: 0, other_property_type: 0, trainingSales: 9, gateSales: 9 },
    expectedRows: 3, published: false, publishedAt: null, createdAt: at('2026-10-20T10:01:00Z'), updatedAt: at('2026-10-20T10:01:00Z'),
    ...over,
  })
}

function plantRow(db: FakeDb, runId: string, contactId: string, bbl: string | null, createdAt: string, over: Record<string, unknown> = {}) {
  db.propertyValuation.rows.push({
    id: `pv_${runId}_${contactId}`, runId, organizationId: ORG, contactId, bbl, value: bbl ? 1830000 : null, low: bbl ? 1537200 : null,
    high: bbl ? 2122800 : null, asOf: at('2026-10-01T00:00:00Z'), reason: bbl ? null : 'not_found', factsJson: null, compsJson: [],
    createdAt: at(createdAt), ...over,
  })
}

test('cachedBbl comes only from published runs, the newest row first', async () => {
  const db = makeFakeDb(); seedSellers(db, 3)
  plantRun(db, 'vr_published_sep', { published: true, publishedAt: at('2026-09-20T11:00:00Z'), asOf: at('2026-09-01T00:00:00Z') })
  plantRun(db, 'vr_published_oct', { published: true, publishedAt: at('2026-10-20T11:00:00Z') })
  plantRun(db, 'vr_failed_nov', { gatesPassed: false, runAt: at('2026-11-20T10:00:00Z') }) // never published
  plantRow(db, 'vr_published_sep', 'c0000', '3000000001', '2026-09-20T10:30:00Z')
  plantRow(db, 'vr_published_oct', 'c0000', '3000000002', '2026-10-20T10:30:00Z')
  plantRow(db, 'vr_failed_nov', 'c0000', '3999999999', '2026-11-20T10:30:00Z') // newest, but its run never published
  plantRow(db, 'vr_failed_nov', 'c0001', '3999999998', '2026-11-20T10:30:00Z')
  plantRow(db, 'vr_published_sep', 'c0002', null, '2026-09-20T10:30:00Z') // not found that month: nothing to cache
  const t = await buildTargets(asPrisma(db), ORG)
  assert.deepEqual(Object.fromEntries(t.sellers.map(s => [s.contactId, s.cachedBbl])), { c0000: '3000000002', c0001: null, c0002: null })
})

test('"latest published" is the newest publish time; a published run without one comes last', async () => {
  const db = makeFakeDb(); seedSellers(db, 3)
  plantRun(db, 'vr_no_time', { published: true, publishedAt: null, asOf: at('2026-08-01T00:00:00Z'), metricsJson: { all: { n: 0 } } })
  plantRun(db, 'vr_sep', { published: true, publishedAt: at('2026-09-20T11:00:00Z'), asOf: at('2026-09-01T00:00:00Z') })
  plantRun(db, 'vr_oct', { published: true, publishedAt: at('2026-10-20T11:00:00Z'), metricsJson: { all: { n: 2 } }, scoreboardJson: { recall: 0.98 } })
  const t = await buildTargets(asPrisma(db), ORG)
  assert.deepEqual(t.previousPublished, {
    runId: 'vr_oct', asOf: '2026-10-01', publishedAt: '2026-10-20T11:00:00.000Z', metrics: { all: { n: 2 } }, scoreboard: { recall: 0.98 },
    counts: { targets: 3, valued: 3, five_plus_units: 0, condo_without_unit: 0, not_found: 0, other_property_type: 0, trainingSales: 9, gateSales: 9 },
  })
  const s = await buildStatus(asPrisma(db), ORG)
  assert.equal(s.latestPublished?.asOf, '2026-10-01')
  assert.equal(s.latestPublished?.publishedAt, '2026-10-20T11:00:00.000Z')
  assert.equal(s.latestPublished?.modelVersion, 'dealflow-gbm90-v1')
  assert.equal(s.latestPublished?.gatesPassed, true)
  assert.deepEqual(s.latestPublished?.gates.map(g => g.value), [0.103, 0.128, 0.667, 1432])
  assert.equal(s.latestPublished?.counts.valued, 3)
})

test('status never shows a value, address, tax lot, contact id or blob, even for a published run with text planted in every field', async () => {
  const db = makeFakeDb(); seedSellers(db, 3)
  const M = 'Zqleakq'
  const planted = {
    modelVersion: `${M} 123 Main St`,
    gatesJson: { reported: { passed: true, checks: passingChecks().map(c => ({ ...c, note: M })) }, checked: { note: M }, extra: M },
    metricsJson: { [M]: M, worst: [{ addr: `${M} St` }] },
    scoreboardJson: { [M]: 1, pairs: [`${M} -> buyer`] },
    sourcesJson: { by: M, datasets: { [M]: { rows: 1 } } },
    countsJson: { targets: 3, valued: M, extra: M, [M]: 1 },
  }
  plantRun(db, 'vr_planted_pub', { published: true, publishedAt: at('2026-10-20T11:00:00Z'), ...planted })
  plantRun(db, 'vr_planted_new', { runAt: at('2026-11-20T10:00:00Z'), ...planted })
  for (const id of ['c0000', 'c0001', 'c0002']) {
    plantRow(db, 'vr_planted_pub', id, '3018230045', '2026-10-20T10:30:00Z', {
      factsJson: { zoning: M, lastSale: { date: '2004-06-01', price: 610000 } }, compsJson: [{ address: `${M} SAMPLE AVENUE`, price: 1700000 }],
    })
  }
  const s = await buildStatus(asPrisma(db), ORG)
  assert.ok(s.latestRun && s.latestPublished, 'both a latest run and a latest published run')
  const text = JSON.stringify(s).toLowerCase()
  for (const leak of [M, '123 main', '1830000', '1537200', '2122800', '1700000', '610000', '3018230045', 'c0000', 'example street', 'homeowner', 'sample', 'addr', 'zoning', 'metrics', 'scoreboard', 'sources', 'datasets']) {
    assert.ok(!text.includes(leak.toLowerCase()), `status leaked ${leak}`)
  }
  for (const run of [s.latestRun!, s.latestPublished!]) {
    assert.deepEqual(Object.keys(run).sort(), RUN_KEYS)
    assert.equal(run.modelVersion, null, 'a stored model version that is not a code is not shown')
    assert.deepEqual(Object.keys(run.counts).sort(), COUNT_KEYS)
    assert.equal(run.counts.valued, null)
    for (const g of run.gates) {
      assert.deepEqual(Object.keys(g).sort(), ['key', 'max', 'min', 'pass', 'value'])
      assert.equal(g.value, null, 'gate checks carrying an unknown field are not trusted')
      assert.equal(g.pass, false)
    }
  }
})

test('status before any run says "no runs yet"', async () => {
  const s = await buildStatus(asPrisma(makeFakeDb()), ORG)
  assert.equal(s.message, 'no runs yet')
  assert.equal(s.latestRun, null)
  assert.equal(s.latestPublished, null)
})

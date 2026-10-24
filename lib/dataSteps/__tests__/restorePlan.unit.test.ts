// Brief 48 (data steps): what --restore would do, from a made-up before-copy and
// made-up current rows (no DB): put removed rows back, revert changed rows,
// delete created rows; refuse when a row moved on; skip an old call list.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyBeforeCopy, type BeforeCopy } from '../common'
import { INSERT_ORDER, planRestore, type RestoreFacts } from '../restore'

function copy(): BeforeCopy {
  const c = emptyBeforeCopy('DS-1', 'b48_x_test', 'org-1', new Date('2026-10-23T12:00:00Z'))
  c.removed = {
    Match: [{ id: 'm1', opportunityId: 'd1', counterpartId: 'b1', counterpartType: 'opportunity' }],
    MojoContact: [{ id: 'd1', mojoId: 'csv_1' }],
    CallQueueEntry: [{ id: 'q2', generationRunId: 'gen-1' }],
  }
  c.changed = {
    CallLog: [{ before: { id: 'l1', contactId: 'd1' }, after: { contactId: 'k1' } }],
    CallQueueEntry: [{ before: { id: 'q1', primaryMatchId: 'm1', contributingMatchIds: ['m3', 'm1'] }, after: { primaryMatchId: null, contributingMatchIds: ['m3'] } }],
  }
  c.callListGenerations = ['gen-1']
  return c
}
const facts = (over: Partial<RestoreFacts> = {}): RestoreFacts => ({
  current: {
    CallLog: [{ id: 'l1', contactId: 'k1' }],
    CallQueueEntry: [{ id: 'q1', primaryMatchId: null, contributingMatchIds: ['m3'] }],
  },
  generationsNow: ['gen-1'], uniqueTaken: {}, reportsOnCreated: 0, ...over,
})

test('removed rows go back parents first, changed rows get their old values, all counted for --expect', () => {
  const p = planRestore(copy(), facts())
  assert.deepEqual(p.refusals, {})
  assert.deepEqual(p.insert.map(i => i.table), ['MojoContact', 'Match', 'CallQueueEntry'])
  assert.deepEqual(p.insert.map(i => i.table), INSERT_ORDER.filter(t => p.insert.some(i => i.table === t)))
  assert.deepEqual(p.revert, [
    { table: 'CallLog', changes: [{ id: 'l1', from: { contactId: 'k1' }, to: { contactId: 'd1' } }] },
    { table: 'CallQueueEntry', changes: [{ id: 'q1', from: { primaryMatchId: null, contributingMatchIds: ['m3'] }, to: { primaryMatchId: 'm1', contributingMatchIds: ['m3', 'm1'] } }] },
  ])
  assert.equal(p.writes, 5)
})

test('refused when a removed row is back, its unique key is taken, or a changed row has other values or is gone', () => {
  const p = planRestore(copy(), facts({
    current: { MojoContact: [{ id: 'd1', mojoId: 'csv_1' }], CallLog: [{ id: 'l1', contactId: 'k9' }], CallQueueEntry: [] },
    uniqueTaken: { Match: ['m1'] },
  }))
  assert.deepEqual(Object.keys(p.refusals).sort(), [
    'CallLog: a changed row has other values now', 'CallQueueEntry: a changed row is gone',
    'Match: another row holds its unique key now', 'MojoContact: a removed row is back already',
  ])
})

test('after the nightly rebuilt the call list, its old rows are skipped (counted), not put back', () => {
  const p = planRestore(copy(), facts({ generationsNow: ['gen-2'], current: { CallLog: [{ id: 'l1', contactId: 'k1' }], CallQueueEntry: [] } }))
  assert.deepEqual(p.refusals, {})
  assert.equal(p.skipped['call-list rows not put back: the nightly rebuilt the list since'], 2)
  assert.ok(!p.insert.some(i => i.table === 'CallQueueEntry'))
  assert.ok(!p.revert.some(r => r.table === 'CallQueueEntry'))
  assert.equal(p.writes, 3)
})

test('created rows are deleted only while still as created; saved reports about one block the restore', () => {
  const c = emptyBeforeCopy('DS-2', 'b48_x_test', 'org-1', new Date())
  const made = { id: 't1', organizationId: 'org-1', category: 'BUYER_ISO', isTestData: true, extractedTitle: '[TEST_48] x', rawEmailId: 'r' }
  c.created = { ExtractedOpportunity: [made, { ...made, id: 't2' }, { ...made, id: 't3' }] }
  const base: RestoreFacts = { current: { ExtractedOpportunity: [made, { ...made, id: 't2', createdAt: 'x', updatedAt: 'y' }] }, generationsNow: [], uniqueTaken: {}, reportsOnCreated: 0 }
  const p = planRestore(c, base)
  assert.deepEqual(p.refusals, { 'ExtractedOpportunity: a created row is gone': ['t3'] })
  assert.deepEqual(p.remove, [{ table: 'ExtractedOpportunity', ids: ['t1', 't2'] }])
  const changed = planRestore(c, { ...base, current: { ExtractedOpportunity: [{ ...made, isTestData: false }] } })
  assert.ok(changed.refusals['ExtractedOpportunity: a created row was changed since'])
  const reports = planRestore(c, { ...base, reportsOnCreated: 2 })
  assert.ok(Object.keys(reports.refusals).some(r => r.startsWith('Report: 2 saved report(s)')))
})

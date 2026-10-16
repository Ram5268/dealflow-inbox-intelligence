// Brief 41.1 (PR H) — scripts/brief41-withdraw-old-buyer-reports.ts: the
// --before guard, and the withdrawn ids recorded in a private file (first)
// and in the AuditLog. Pure: no DB (a stand-in for the Prisma client records
// the calls), no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FIX_LIVE_AT, NOTE, RECOMMENDED_CUTOFF, SECTION_NOTE, TEMPLATE, applyWithdrawal, parseCutoff,
  type WithdrawDb, type WithdrawalRecord,
} from '../reports/withdrawOldReports'

const NOW = new Date('2026-10-11T12:00:00Z')

test('the recommended cutoff is 2026-10-06T05:55:00Z: past the 05:51:09Z deploy plus a 60 s request margin', () => {
  assert.equal(RECOMMENDED_CUTOFF, '2026-10-06T05:55:00Z')
  assert.ok(Date.parse(RECOMMENDED_CUTOFF) - Date.parse(FIX_LIVE_AT) >= 60_000)
  const ok = parseCutoff(RECOMMENDED_CUTOFF, NOW)
  assert.ok('before' in ok)
  assert.equal(ok.before.toISOString(), '2026-10-06T05:55:00.000Z')
})

test('--before later than now is refused', () => {
  for (const later of ['2026-10-11T12:00:01Z', '2026-12-01T00:00:00Z', '2026-10-11T08:00:01-04:00']) {
    const r = parseCutoff(later, NOW)
    assert.ok('error' in r && /later than now/.test(r.error), later)
  }
  assert.ok('before' in parseCutoff('2026-10-11T12:00:00Z', NOW)) // now itself is fine
})

test('a bad or ambiguous --before is refused; the usage names the recommended cutoff', () => {
  for (const bad of [
    'yesterday', '2026-10-06', '2026-10-06T05:55:00', // no time, or no time zone (read as this Mac's local time)
    '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-06T24:00:00Z', '2026-10-06T05:60:00Z', '2026-10-06T05:55:00+15:00',
    '10/06/2026 05:55', '',
  ]) {
    const r = parseCutoff(bad, NOW)
    assert.ok('error' in r, bad)
  }
  for (const missing of [undefined, '--apply']) {
    const r = parseCutoff(missing, NOW)
    assert.ok('error' in r && r.error.includes(RECOMMENDED_CUTOFF))
  }
  // Other zones and precisions are fine.
  const r = parseCutoff('2026-10-06T01:55:00.000-04:00', NOW)
  assert.ok('before' in r && r.before.toISOString() === '2026-10-06T05:55:00.000Z')
  assert.ok('before' in parseCutoff('2026-10-06T05:55Z', NOW))
})

// A stand-in for the Prisma client: the update calls build the operations,
// $transaction runs them; every call is logged in order. `failWith` makes the
// transaction fail (a timeout, a dropped connection).
function fakeDb(failWith?: Error) {
  const log: string[] = []
  const calls: Record<string, unknown> = {}
  const op = (name: string) => (args: unknown) => { log.push(name); calls[name] = args; return Promise.resolve({ count: 1 }) }
  const db = {
    report: { updateMany: op('report.updateMany') },
    chatMessage: { updateMany: op('chatMessage.updateMany') },
    auditLog: { create: op('auditLog.create') },
    $transaction: async (ops: Promise<unknown>[]) => {
      log.push('$transaction')
      if (failWith) throw failWith
      return Promise.all(ops)
    },
  }
  return { db: db as unknown as WithdrawDb, log, calls }
}

const DB_NULL = { dbNull: true } as never // stands in for Prisma.DbNull

test('the withdrawn report and chat-message ids are written to the private file first, then the AuditLog', async () => {
  const { db, log, calls } = fakeDb()
  let record: WithdrawalRecord | null = null
  const before = new Date(RECOMMENDED_CUTOFF)
  const { recordFile } = await applyWithdrawal(db, {
    organizationId: 'org1', before, reportIds: ['r1', 'r2'], chatMessageIds: ['m1'], now: NOW, dbNull: DB_NULL,
    writeRecord: (r) => { log.push('writeRecord'); record = r; return '/private/withdraw.json' },
  })
  assert.equal(recordFile, '/private/withdraw.json')
  assert.deepEqual(log, ['writeRecord', 'report.updateMany', 'chatMessage.updateMany', 'auditLog.create', '$transaction'])
  const written = record as WithdrawalRecord | null
  assert.deepEqual([written?.reportIds, written?.chatMessageIds, written?.before], [['r1', 'r2'], ['m1'], '2026-10-06T05:55:00.000Z'])
  assert.deepEqual(Object.keys(written ?? {}), ['what', 'writtenAt', 'before', 'reportIds', 'chatMessageIds']) // ids only, never the old content
  const audit = calls['auditLog.create'] as { data: { action: string; organizationId: string; detailsJson: Record<string, unknown> } }
  assert.equal(audit.data.action, 'OLD_BUYER_REPORTS_WITHDRAWN')
  assert.deepEqual(audit.data.detailsJson, {
    source: 'brief41-withdraw-old-buyer-reports', at: NOW.toISOString(), before: '2026-10-06T05:55:00.000Z',
    reports: 2, chatSections: 1, reportIds: ['r1', 'r2'], chatMessageIds: ['m1'], recordFile: '/private/withdraw.json',
  })
  // The updates re-check what the ids were found by, and replace the content with the note.
  assert.deepEqual(calls['report.updateMany'], {
    where: { id: { in: ['r1', 'r2'] }, templateId: TEMPLATE, createdAt: { lt: before } },
    data: { markdown: NOTE, sections: [{ key: 'withdrawn', title: 'Report withdrawn', content: { prose: NOTE }, sources: [] }], sources: [] },
  })
  assert.deepEqual(calls['chatMessage.updateMany'], {
    where: { id: { in: ['m1'] }, createdAt: { lt: before }, attachedFragment: { path: ['templateId'], equals: TEMPLATE } },
    data: { attachedFragment: DB_NULL, content: SECTION_NOTE },
  })
})

test('if the private file can\'t be written, nothing is withdrawn', async () => {
  const { db, log } = fakeDb()
  await assert.rejects(applyWithdrawal(db, {
    organizationId: 'org1', before: new Date(RECOMMENDED_CUTOFF), reportIds: ['r1'], chatMessageIds: [], now: NOW, dbNull: DB_NULL,
    writeRecord: () => { throw new Error('EACCES') },
  }), /EACCES/)
  assert.deepEqual(log, [])
})

test('a transaction that fails says the ids were written but nothing was withdrawn', async () => {
  const dropped = new Error("Can't reach database server")
  const { db } = fakeDb(dropped)
  const said: string[] = []
  await assert.rejects(applyWithdrawal(db, {
    organizationId: 'org1', before: new Date(RECOMMENDED_CUTOFF), reportIds: ['r1'], chatMessageIds: ['m1'], now: NOW, dbNull: DB_NULL,
    writeRecord: () => '/private/withdraw.json', log: (l) => said.push(l),
  }), (e: Error) => e === dropped)
  assert.deepEqual(said, [
    'Ids written but NOT applied: nothing changed (the transaction failed and was rolled back). ' +
    'Re-run the dry run to confirm. Record: /private/withdraw.json',
  ])
})

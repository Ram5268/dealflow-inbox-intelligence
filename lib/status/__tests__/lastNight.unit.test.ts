// Brief 47 (PR 4): the status window on GET /api/debug/health ("what happened last
// night"), on an in-memory stand-in for Prisma (no database, no network). No nightly
// yet, a normal night, a rollback night and a refused night; junk in an AuditLog row's
// detailsJson is never copied; one failing read blanks only its own block; reads only.
// Runs under tsx; every count, time and id here is invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readStatusWindow, reasonCodes, mapScoring } from '../lastNight'

type Row = Record<string, unknown>
type Audit = { id: string; organizationId: string; action: string; createdAt: Date; detailsJson: unknown }

const pick = (row: Row, select?: Row): Row =>
  select ? Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]])) : { ...row }

let nextId = 1
const audit = (action: string, at: string, detailsJson: unknown): Audit =>
  ({ id: `cm-planted-row-${nextId++}`, organizationId: 'org-planted-id', action, createdAt: new Date(at), detailsJson })

// The stand-in. Only reads exist on it: a write would throw (and show up as a blank block).
function standIn({ rows = [] as Audit[], flag = null as unknown, usage = [] as Row[], fail = [] as string[] } = {}) {
  const ops: string[] = []
  const selects: unknown[] = []
  const boom = (what: string) => { if (fail.includes(what)) throw new Error('connection reset') }
  const db = {
    auditLog: {
      findFirst: async ({ where, orderBy, select }: { where: { action: string }; orderBy: unknown; select?: Row }) => {
        ops.push('auditLog.findFirst')
        selects.push(select)
        boom(`auditLog:${where.action}`)
        assert.deepEqual(orderBy, { createdAt: 'desc' })
        const newest = rows.filter(r => r.action === where.action).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
        return newest ? pick(newest as unknown as Row, select) : null
      },
    },
    featureFlag: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        ops.push('featureFlag.findUnique')
        boom('featureFlag')
        return where.id === 'USE_OUR_ESTIMATES' ? flag : null
      },
    },
    rapidApiUsage: {
      findUnique: async ({ where }: { where: { yearMonth: string } }) => {
        ops.push('rapidApiUsage.findUnique')
        boom('rapidApiUsage')
        return usage.find(u => u.yearMonth === where.yearMonth) ?? null
      },
    },
  }
  return { db, ops, selects }
}

const failed: string[] = []
async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn() } catch { failed.push(label); return fallback }
}

const SWITCH_ENV = ['GRAPH_ENABLED', 'MAINTENANCE_ENABLED', 'INSTANTLY_ENROLL_ENABLED', 'STREETEASY_SYNC_ENABLED', 'TEST_MODE_ONLY']
// Only this test process's own env is set (HELPER_RULES rule 9).
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev = Object.fromEntries(SWITCH_ENV.map(k => [k, process.env[k]]))
  for (const k of SWITCH_ENV) delete process.env[k]
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v
  try { return await fn() } finally {
    for (const k of SWITCH_ENV) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

const NOW = new Date('2026-10-19T14:00:00Z')
const read = (db: ReturnType<typeof standIn>['db'], now = NOW) => readStatusWindow(db as never, safe, now)

// A night's rows, as the nightly writes them (lib/crm-sync/runSync.ts, runScoring.ts, queueBuilder.ts).
const SYNC = {
  dryRun: false, crmLeads: 1498, inserted: 3, updated: 1495, rekeyed: 0, duplicatesMarked: 2, legacyMarked: 0,
  removedMarked: 1, neighborhoodsResolved: 3, filled: { phone: 4 }, skipped: { noAddress: 1 }, ms: 4100,
}
const CHECK_OK = {
  rolledBack: false, reasons: [], sellersPricedByOurValue: 1434, hotWithout: 800, hotWith: 812,
  sellersWithMatchesWithout: 1400, sellersLosingAllMatches: 3,
}
const SCORING = {
  dryRun: false, includeTestBuyers: true, sellers: 1498, buyers: 250, demandExcludedNoLocation: 4, pairs: 374500,
  eligible: 90000, ineligibleByReason: { location: 200000 }, dismissed: 2, kept: 8213, sellersCovered: 1478,
  inserted: 10, updated: 8203, deleted: 5, tiers: { HOT: 812, WARM: 2401, POSSIBLE: 5000 }, confidence: { high: 10 },
  topUnknownFactors: { beds: 3 }, ms: 52000,
}
const QUEUE = {
  generationRunId: 'run-planted-id', totalContactsConsidered: 1498, exclusionCounts: { no_phone: 20 }, queueLength: 1478,
  priorityDistribution: { top10Avg: 0.9, top50Avg: 0.8, rank1Score: 0.95, rank50Score: 0.7, spread: 0.25 },
}

test('no nightly yet: every lastNight block is null, and the switches still show', async () => {
  const { db } = standIn({ flag: { enabled: true } })
  const status = await withEnv({}, () => read(db))
  assert.deepEqual(status, {
    lastNight: { crmLeadSync: null, scoring: null, callQueue: null },
    valuationSwitch: {
      useOurEstimates: true, lastNightUsedOurValues: null,
      lastRollback: null, lastScoringRefusal: null, lastCallListRefusal: null,
    },
    switches: { outlook: false, maintenance: false, instantly: false, streetEasySync: true },
    rapidApi: { month: '2026-10', calls: 0 },
  })
  // No USE_OUR_ESTIMATES row at all: the switch is off.
  const none = await withEnv({}, () => read(standIn().db))
  assert.equal(none.valuationSwitch.useOurEstimates, false)
})

test('a normal night with our values: counts, tiers, UTC times, and our values used', async () => {
  const { db } = standIn({
    rows: [
      audit('CRM_LEAD_SYNC', '2026-10-18T09:00:04Z', { ...SYNC, crmLeads: 1490 }), // the night before
      audit('CRM_LEAD_SYNC', '2026-10-19T09:00:05Z', SYNC),
      audit('NIGHTLY_SCORING', '2026-10-19T09:02:00Z', { ...SCORING, ourEstimates: CHECK_OK }),
      audit('CALL_QUEUE_BUILD', '2026-10-19T09:03:30Z', QUEUE),
    ],
    flag: { enabled: true },
    usage: [{ yearMonth: '2026-09', callsConsumed: 9000 }, { yearMonth: '2026-10', callsConsumed: 37 }],
  })
  const status = await withEnv({}, () => read(db))
  assert.deepEqual(status.lastNight, {
    crmLeadSync: {
      finishedAt: '2026-10-19T09:00:05.000Z', crmLeads: 1498, inserted: 3, updated: 1495, rekeyed: 0,
      duplicatesMarked: 2, legacyMarked: 0, removedMarked: 1,
    },
    scoring: {
      finishedAt: '2026-10-19T09:02:00.000Z', sellers: 1498, buyers: 250, kept: 8213,
      tiers: { HOT: 812, WARM: 2401, POSSIBLE: 5000 }, sellersPricedByOurValues: 1434,
    },
    callQueue: { finishedAt: '2026-10-19T09:03:30.000Z', queueLength: 1478, totalContactsConsidered: 1498 },
  })
  assert.equal(status.valuationSwitch.useOurEstimates, true)
  assert.equal(status.valuationSwitch.lastNightUsedOurValues, true)
  assert.equal(status.valuationSwitch.lastRollback, null)
  assert.deepEqual(status.rapidApi, { month: '2026-10', calls: 37 })
})

test('a night with the switch off: our values not used, none priced by them, a missing tier is 0', async () => {
  const { db } = standIn({
    rows: [audit('NIGHTLY_SCORING', '2026-10-19T09:02:00Z', { ...SCORING, tiers: { HOT: 3, WARM: 7 } })],
    flag: { enabled: false },
  })
  const status = await withEnv({}, () => read(db))
  assert.deepEqual(status.lastNight.scoring?.tiers, { HOT: 3, WARM: 7, POSSIBLE: 0 })
  assert.equal(status.lastNight.scoring?.sellersPricedByOurValues, 0)
  assert.equal(status.valuationSwitch.useOurEstimates, false)
  assert.equal(status.valuationSwitch.lastNightUsedOurValues, false)
})

test('a rollback night: the newest rollback with its reason codes, and our values not used', async () => {
  const check = { ...CHECK_OK, rolledBack: true, reasons: ['hot_halved', 'sellers_lost_matches'], hotWith: 300 }
  const { db } = standIn({
    rows: [
      audit('VALUATION_SWITCH_ROLLBACK', '2026-09-30T09:01:00Z', { ...check, reasons: ['error'] }), // an older one
      audit('NIGHTLY_SCORING', '2026-10-19T09:02:00Z', { ...SCORING, ourEstimates: check }),
      audit('VALUATION_SWITCH_ROLLBACK', '2026-10-19T09:02:00Z', check),
    ],
    flag: { enabled: false }, // the rollback turned it off
  })
  const status = await withEnv({}, () => read(db))
  assert.deepEqual(status.valuationSwitch, {
    useOurEstimates: false,
    lastNightUsedOurValues: false,
    lastRollback: { at: '2026-10-19T09:02:00.000Z', reasons: ['hot_halved', 'sellers_lost_matches'] },
    lastScoringRefusal: null,
    lastCallListRefusal: null,
  })
  assert.equal(status.lastNight.scoring?.sellersPricedByOurValues, 0)
  assert.equal(status.lastNight.scoring?.kept, 8213)
})

test('a refused night (written by the nightly, Brief 47 PR 1): the newest refusals with their codes', async () => {
  const { db } = standIn({
    rows: [
      audit('NIGHTLY_SCORING', '2026-10-17T09:02:00Z', SCORING), // the last night that went through
      audit('CALL_QUEUE_BUILD', '2026-10-17T09:03:00Z', QUEUE),
      audit('NIGHTLY_SCORING_REFUSED', '2026-10-18T09:02:00Z', { reasons: ['matches_shrank'], sellers: 1498, buyers: 250 }),
      audit('NIGHTLY_SCORING_REFUSED', '2026-10-19T09:02:00Z', {
        reasons: ['no_buyers'], sellers: 1498, buyers: 0, kept: 0, sellersCovered: 0,
        existingMatches: 8213, existingSellersCovered: 1478, includeTestBuyers: false,
      }),
      audit('CALL_QUEUE_BUILD_REFUSED', '2026-10-19T09:03:00Z', {
        reasons: ['empty_list'], totalContactsConsidered: 1498, exclusionCounts: { no_match: 1498 }, queueLength: 0,
      }),
    ],
    flag: { enabled: true },
  })
  const status = await withEnv({}, () => read(db))
  assert.deepEqual(status.valuationSwitch.lastScoringRefusal, { at: '2026-10-19T09:02:00.000Z', reasons: ['no_buyers'] })
  assert.deepEqual(status.valuationSwitch.lastCallListRefusal, { at: '2026-10-19T09:03:00.000Z', reasons: ['empty_list'] })
  // The steps' own rows are still the last ones that went through, with their own times.
  assert.equal(status.lastNight.scoring?.finishedAt, '2026-10-17T09:02:00.000Z')
  assert.equal(status.lastNight.callQueue?.finishedAt, '2026-10-17T09:03:00.000Z')
  assert.equal(status.valuationSwitch.lastNightUsedOurValues, false)
})

test('junk in detailsJson (strings, ids, objects, addresses) is never copied', async () => {
  const { db } = standIn({
    rows: [
      audit('CRM_LEAD_SYNC', '2026-10-19T09:00:00Z', {
        crmLeads: '1498', inserted: { n: 3 }, updated: [1495], rekeyed: null, duplicatesMarked: true, legacyMarked: 'cm-planted-id',
        removedMarked: 1, mojoId: 'mojo-planted-id', address: '123 Example St', fullName: 'Planted Name',
      }),
      audit('NIGHTLY_SCORING', '2026-10-19T09:02:00Z', {
        sellers: 'lots', buyers: 250, kept: '8213', tiers: { HOT: 'many', WARM: 4, SECRET: 9, 'cm-planted-id': 1 },
        ourEstimates: { rolledBack: 'false', sellersPricedByOurValue: 1434, sellerId: 'cm-planted-id' },
      }),
      audit('CALL_QUEUE_BUILD', '2026-10-19T09:03:00Z', null),
      audit('VALUATION_SWITCH_ROLLBACK', '2026-10-19T09:02:00Z', {
        reasons: ['hot_halved', 'Hot_Halved', 'seller cm-planted-id', '123 Example St', 'x-y', 42, null, { code: 'error' }, ''],
      }),
      audit('NIGHTLY_SCORING_REFUSED', '2026-10-19T09:02:00Z', ['no_buyers']), // not an object
      audit('CALL_QUEUE_BUILD_REFUSED', '2026-10-19T09:03:00Z', { reasons: 'empty_list' }), // not a list
    ],
  })
  const status = await withEnv({}, () => read(db))
  assert.deepEqual(status.lastNight.crmLeadSync, {
    finishedAt: '2026-10-19T09:00:00.000Z', crmLeads: null, inserted: null, updated: null, rekeyed: null,
    duplicatesMarked: null, legacyMarked: null, removedMarked: 1,
  })
  assert.deepEqual(status.lastNight.scoring, {
    finishedAt: '2026-10-19T09:02:00.000Z', sellers: null, buyers: 250, kept: null,
    tiers: { HOT: 0, WARM: 4, POSSIBLE: 0 }, sellersPricedByOurValues: 0,
  })
  assert.deepEqual(status.lastNight.callQueue, { finishedAt: '2026-10-19T09:03:00.000Z', queueLength: null, totalContactsConsidered: null })
  assert.equal(status.valuationSwitch.lastNightUsedOurValues, false) // 'false' (a string) is not false
  assert.deepEqual(status.valuationSwitch.lastRollback?.reasons, ['hot_halved'])
  assert.deepEqual(status.valuationSwitch.lastScoringRefusal?.reasons, [])
  assert.deepEqual(status.valuationSwitch.lastCallListRefusal?.reasons, [])
  const out = JSON.stringify(status)
  for (const planted of ['planted', 'Example', 'SECRET', 'Hot_Halved', 'x-y', 'org-']) assert.ok(!out.includes(planted), planted)
  // The pure pieces, on values JSON can't hold.
  assert.deepEqual(reasonCodes(['error', 'A', 'no buyers', 'no_buyers\n']), ['error'])
  assert.equal(mapScoring({ createdAt: new Date('2026-10-19T09:02:00Z'), detailsJson: { sellers: NaN, buyers: Infinity } })?.sellers, null)
  assert.equal(mapScoring({ createdAt: new Date('2026-10-19T09:02:00Z'), detailsJson: { sellers: NaN, buyers: Infinity } })?.buyers, null)
})

test('one failing read blanks only its own block', async () => {
  failed.length = 0
  const { db } = standIn({
    rows: [
      audit('CRM_LEAD_SYNC', '2026-10-19T09:00:05Z', SYNC),
      audit('NIGHTLY_SCORING', '2026-10-19T09:02:00Z', { ...SCORING, ourEstimates: CHECK_OK }),
      audit('CALL_QUEUE_BUILD', '2026-10-19T09:03:30Z', QUEUE),
    ],
    flag: { enabled: true },
    usage: [{ yearMonth: '2026-10', callsConsumed: 37 }],
    fail: ['auditLog:NIGHTLY_SCORING', 'featureFlag', 'rapidApiUsage'],
  })
  const status = await withEnv({}, () => read(db))
  assert.equal(status.lastNight.scoring, null)
  assert.equal(status.valuationSwitch.lastNightUsedOurValues, null)
  assert.equal(status.valuationSwitch.useOurEstimates, null) // unknown, not "off"
  assert.deepEqual(status.rapidApi, { month: '2026-10', calls: null })
  assert.equal(status.lastNight.crmLeadSync?.crmLeads, 1498)
  assert.equal(status.lastNight.callQueue?.queueLength, 1478)
  assert.deepEqual(status.switches, { outlook: false, maintenance: false, instantly: false, streetEasySync: true })
  assert.equal(failed.length, 3)
})

test('the other switches: on only when exactly "true"; StreetEasy sync as its entry points gate it', async () => {
  const cases: Array<[Record<string, string>, Record<string, boolean>]> = [
    [{}, { outlook: false, maintenance: false, instantly: false, streetEasySync: true }],
    [{ GRAPH_ENABLED: 'true', MAINTENANCE_ENABLED: 'true', INSTANTLY_ENROLL_ENABLED: 'true' },
      { outlook: true, maintenance: true, instantly: true, streetEasySync: true }],
    [{ GRAPH_ENABLED: 'TRUE', MAINTENANCE_ENABLED: '1', INSTANTLY_ENROLL_ENABLED: 'yes' },
      { outlook: false, maintenance: false, instantly: false, streetEasySync: true }],
    [{ STREETEASY_SYNC_ENABLED: 'false' }, { outlook: false, maintenance: false, instantly: false, streetEasySync: false }],
    [{ STREETEASY_SYNC_ENABLED: 'FALSE' }, { outlook: false, maintenance: false, instantly: false, streetEasySync: true }],
    [{ TEST_MODE_ONLY: 'true' }, { outlook: false, maintenance: false, instantly: false, streetEasySync: false }],
  ]
  for (const [env, want] of cases) {
    const status = await withEnv(env, () => read(standIn().db))
    assert.deepEqual(status.switches, want, JSON.stringify(env))
  }
})

test("RapidAPI calls are this UTC month's, as lib/streetEasySync.ts counts them", async () => {
  // 23:30 EDT on Oct 31 is already November in UTC, the month the counter writes to.
  const { db } = standIn({ usage: [{ yearMonth: '2026-10', callsConsumed: 500 }, { yearMonth: '2026-11', callsConsumed: 3 }] })
  const status = await withEnv({}, () => read(db, new Date('2026-11-01T03:30:00Z')))
  assert.deepEqual(status.rapidApi, { month: '2026-11', calls: 3 })
})

test('reads only: findFirst/findUnique, and AuditLog rows select their time and details only', async () => {
  const { db, ops, selects } = standIn({ rows: [audit('NIGHTLY_SCORING', '2026-10-19T09:02:00Z', SCORING)], flag: { enabled: true } })
  await withEnv({}, () => read(db))
  assert.ok(ops.length > 0)
  for (const op of ops) assert.match(op, /\.(findFirst|findUnique)$/)
  for (const s of selects) assert.deepEqual(s, { createdAt: true, detailsJson: true })
  assert.equal(ops.filter(o => o === 'auditLog.findFirst').length, 6) // three steps, a rollback, two refusals
})

// Brief 45 (PR E) — POST /api/crm/score-import's handler against real Postgres:
// DealFlow's database (DATABASE_URL) and a CRM one (CRM_TEST_DATABASE_URL),
// both *_test databases with their schemas loaded (the CRM's with Brief 45's
// ImportBatch columns). Seeds made-up people (seedTestDbs.ts), runs the
// handler with its real database clients, checks every write, then deletes
// its rows. npm run test:integration, or alone:
//   DATABASE_URL=<dealflow *_test> CRM_TEST_DATABASE_URL=<crm *_test> npx --yes tsx <this file>
// SCORE_IMPORT_TIMING=1 seeds the full-size case instead (1,500 sellers,
// 250 buyers, 500 new leads) and prints the time and round trips.
// First, so the guard runs before anything touches a database.
import '../../__tests__/requireTestDb'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { isTestDatabase } from '../../dbGuard'
import { scoreImport } from '../scoreImport'
import { prisma } from '../../prisma'
import { closeCrmPool } from '../../crm-sync/roClient'
import { CRM_ORG, DF_ORG, IMPORT_EXPIRED, IMPORT_OK, IMPORT_RUNNING, cleanup, seed, type Seeded, type Sizes } from './seedTestDbs'

const crmUrl = process.env.CRM_TEST_DATABASE_URL
if (!isTestDatabase(crmUrl)) throw new Error('REFUSING: CRM_TEST_DATABASE_URL must name a *_test or *_perf database')
// The handler's read-only CRM link goes to the test database this file seeds,
// whatever the environment held. roClient.ts reads the setting at its first
// query, which comes after this line (the imports above open no connection).
process.env.DATABASE_URL_CRM_RO = crmUrl

// Count round trips per database (Railway adds about 90 ms each).
const trips: Record<string, number> = {}
const realQuery = pg.Client.prototype.query
pg.Client.prototype.query = function (this: pg.Client & { connectionParameters?: { database?: string } }, ...args: unknown[]) {
  const db = this.connectionParameters?.database ?? '?'
  trips[db] = (trips[db] ?? 0) + 1
  return (realQuery as (...a: unknown[]) => unknown).apply(this, args)
} as typeof realQuery

const TIMING = process.env.SCORE_IMPORT_TIMING === '1'
const SIZES: Sizes = TIMING
  ? { sellers: 1500, isoBuyers: 200, mojoBuyers: 50, newLeads: 500, noMojo: 0, merged: 0 }
  : { sellers: 40, isoBuyers: 20, mojoBuyers: 10, newLeads: 12, noMojo: 2, merged: 2 }

const df = new pg.Client({ connectionString: process.env.DATABASE_URL })
const crm = new pg.Client({ connectionString: crmUrl })
let s: Seeded

before(async () => {
  await df.connect()
  await crm.connect()
  const [{ d }] = (await df.query('SELECT current_database() AS d')).rows
  const [{ c }] = (await crm.query('SELECT current_database() AS c')).rows
  assert.ok(/(_test|_perf)$/.test(d) && /(_test|_perf)$/.test(c) && d !== c, 'two distinct test databases')
  await cleanup(df, crm)
  s = await seed(df, crm, SIZES)
})

after(async () => {
  await cleanup(df, crm)
  await df.end()
  await crm.end()
  await prisma.$disconnect()
  await closeCrmPool()
})

type Body = { scored: Record<string, unknown>[]; skipped: { crmLeadId: string; reason: string }[]; ms: number } & Record<string, unknown>
const call = (over: Record<string, unknown> = {}) => scoreImport({ importId: IMPORT_OK, token: s.token, leadIds: s.requestIds, ...over })

// Everything DealFlow holds for the test organization, row by row.
async function snapshot() {
  const q = async (sql: string) => (await df.query(sql, [DF_ORG])).rows
  return {
    contacts: await q(`SELECT * FROM "MojoContact" WHERE "organizationId" = $1 ORDER BY id`),
    matches: await q(`SELECT * FROM "Match" WHERE "organizationId" = $1 ORDER BY id`),
    queue: await q(`SELECT * FROM "CallQueueEntry" WHERE "organizationId" = $1 ORDER BY id`),
    audits: await q(`SELECT * FROM "AuditLog" WHERE "organizationId" = $1 ORDER BY id`),
  }
}

test('refusals read one ImportBatch row and write nothing', { skip: TIMING }, async () => {
  const before = await snapshot()
  const wrong = Buffer.alloc(32, 7).toString('base64url')
  for (const [over, status, error] of [
    [{ importId: 'b45e_no_such_import' }, 404, 'not_found'],
    [{ token: wrong }, 403, 'bad_token'],
    [{ importId: IMPORT_RUNNING }, 403, 'not_completed'],
    [{ importId: IMPORT_EXPIRED }, 403, 'expired'],
    [{ leadIds: [] }, 400, 'invalid_request'],
  ] as const) {
    assert.deepEqual(await call(over), { status, body: { error } }, error)
  }
  assert.deepEqual(await snapshot(), before)
})

test('the upload\'s new leads are copied, scored and ranked; nothing else changes', async () => {
  const before = await snapshot()
  for (const k of Object.keys(trips)) delete trips[k]
  const t0 = Date.now()
  const res = await call()
  const ms = Date.now() - t0
  const body = res.body as Body
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const after = await snapshot()

  if (TIMING) {
    console.log(`TIMING ${s.requestIds.length} new leads × ${SIZES.isoBuyers + SIZES.mojoBuyers} buyers, ${SIZES.sellers} existing sellers: ` +
      `handler ${ms} ms (body.ms ${body.ms}); round trips ${JSON.stringify(trips)}; ranked ${body.scored.filter(x => x.notRankedReason === null).length}, ` +
      `not ranked ${body.scored.filter(x => x.notRankedReason !== null).length}, skipped ${body.skipped.length}; ` +
      `audit ${JSON.stringify(after.audits.at(-1)?.detailsJson)}`)
  }

  // Each requested lead comes back once: new ones scored, the rest skipped with a reason.
  assert.deepEqual(body.scored.map(x => x.crmLeadId), s.newLeads.map(p => p.id))
  assert.deepEqual(body.skipped, [...s.noMojo.map(p => ({ crmLeadId: p.id, reason: 'no_mojo_id' })),
    ...s.merged.map(p => ({ crmLeadId: p.id, reason: 'not_new_in_import' }))])

  // The lead copy: one DealFlow seller per new lead, marked as a CRM lead.
  const byMojo = new Map(after.contacts.map(c => [c.mojoId, c]))
  for (const p of s.newLeads) {
    const c = byMojo.get(p.mojoId)!
    assert.ok(c, p.id)
    assert.equal(c.metadata.source, 'crm')
    assert.equal(c.metadata.crmLeadId, p.id)
  }
  assert.equal(after.contacts.length, before.contacts.length + s.newLeads.length - 1) // one was copied before
  for (const p of [...s.noMojo, ...s.merged]) assert.ok(!byMojo.has(p.mojoId) || p.mojoId === null, p.id)

  // Keep-old [Ryan, Brief 34] on the earlier copy: its value stays, blanks fill.
  const pre = after.contacts.find(c => c.id === 'b45e_mc_pre')!
  assert.equal(pre.status, 'Earlier status')
  assert.equal(pre.city, 'Brooklyn')
  assert.equal(pre.phone?.length, 10)

  // Existing sellers: their rows, their matches and the morning list are untouched.
  const newIds = new Set(s.newLeads.map(p => byMojo.get(p.mojoId)!.id as string))
  const untouched = (rows: Record<string, unknown>[], key: string) => rows.filter(r => !newIds.has(r[key] as string))
  assert.deepEqual(untouched(after.contacts, 'id'), untouched(before.contacts, 'id'))
  assert.deepEqual(untouched(after.matches, 'opportunityId'), untouched(before.matches, 'opportunityId'))
  assert.deepEqual(after.queue, before.queue)
  assert.ok(!after.matches.some(m => m.id === 'b45e_match_stale_pre'), 'the new seller\'s stale match is gone')

  // One audit row, counts only.
  assert.equal(after.audits.length, before.audits.length + 1)
  assert.equal(after.audits.at(-1)!.action, 'CRM_IMPORT_SCORING')

  // The response matches what DealFlow now holds.
  const matchById = new Map(after.matches.map(m => [m.id, m]))
  const ranked = body.scored.filter(x => x.notRankedReason === null)
  assert.ok(ranked.length > 0, 'some new leads have buyers')
  for (const x of body.scored) {
    const seller = byMojo.get(x.mojoId)!
    const mine = after.matches.filter(m => m.opportunityId === seller.id)
    if (x.notRankedReason !== null) {
      assert.equal(x.priorityScore, null)
      if (x.notRankedReason === 'no_matches') assert.equal(mine.length, 0)
      continue
    }
    const primary = matchById.get(x.primaryMatchId as string)!
    assert.equal(primary.opportunityId, seller.id)
    assert.equal(x.primaryMatchFit, primary.score)
    assert.equal(x.primaryMatchFit, Math.max(...mine.map(m => m.score)))
    assert.equal(x.matchReason, primary.reason)
    const buyers = x.buyers as Record<string, unknown>[]
    assert.ok(buyers.length >= 1 && buyers.length <= 5)
    assert.ok(buyers.every(b => mine.some(m => m.id === b.matchId)))
    assert.ok(!/example\.com|phone|email/i.test(JSON.stringify(buyers)), 'no phone or email reaches the CRM')
  }
})

test('asking again (same token, still within the hour) changes nothing more', { skip: TIMING }, async () => {
  const first = await snapshot()
  const res = await call()
  assert.equal(res.status, 200)
  const second = await snapshot()
  assert.deepEqual(second.contacts.map(c => [c.id, c.mojoId, c.status]), first.contacts.map(c => [c.id, c.mojoId, c.status]))
  assert.deepEqual(second.matches.map(m => [m.id, m.score]), first.matches.map(m => [m.id, m.score]))
  assert.deepEqual(second.queue, first.queue)
  // The CRM's records were only read.
  const [{ n }] = (await crm.query(`SELECT count(*)::int AS n FROM "Lead" WHERE "organizationId" = $1 AND "priorityScore" IS NOT NULL`, [CRM_ORG])).rows
  assert.equal(n, 0)
})

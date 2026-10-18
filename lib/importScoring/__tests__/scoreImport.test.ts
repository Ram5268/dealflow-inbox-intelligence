import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { scoreImport, type ScoreImportDeps } from '../scoreImport'
import { IMPORT_BATCH_SQL, NEW_IMPORT_LEADS_SQL } from '../crmRead'
import { DUPLICATES_SQL, LEGACY_SQL, REKEY_SQL, REMOVED_SQL, UPSERT_SQL } from '../../crm-sync/upsert'
import { DELETE_STALE_MATCHES_OF_SELLERS_SQL, DELETE_STALE_MATCHES_SQL, UPSERT_MATCHES_SQL } from '../../matching/nightly/sql'
import { memoryDb, type Row } from '../../__tests__/memoryDb'
import {
  IMPORT_ID, NOW, REQUEST_IDS, TOKEN, TOKEN_HASH, crmWorld, dealflowDb, dealflowWorld, importRaw,
} from './importFixture'

// Brief 45 (PR E): POST /api/crm/score-import end to end against in-memory
// stand-ins for both databases (the CRM's read-only link and DealFlow's
// Prisma). The scorer and the call-priority logic are the real ones. No
// database, no network.

const prevTestBuyers = process.env.SCORING_INCLUDE_TEST_BUYERS
after(() => { if (prevTestBuyers === undefined) delete process.env.SCORING_INCLUDE_TEST_BUYERS; else process.env.SCORING_INCLUDE_TEST_BUYERS = prevTestBuyers })

type Mem = ReturnType<typeof memoryDb>
function setup(over: { batch?: Row | null; mem?: Mem } = {}) {
  const crm = crmWorld({ batch: over.batch })
  const mem = over.mem ?? dealflowDb()
  const deps: ScoreImportDeps = {
    crmQuery: crm.crmQuery, readCrmLeads: crm.readCrmLeads, db: mem.db as unknown as PrismaClient, now: () => NOW,
  }
  return { crm, mem, deps }
}
const request = (over: Record<string, unknown> = {}) => ({ importId: IMPORT_ID, token: TOKEN, leadIds: REQUEST_IDS, ...over })
type Body = Record<string, unknown> & { scored: Row[]; skipped: { crmLeadId: string; reason: string }[] }

async function run(over: { batch?: Row | null; mem?: Mem; body?: unknown } = {}) {
  const s = setup(over)
  const res = await scoreImport(over.body === undefined ? request() : over.body, s.deps)
  return { ...s, res, body: res.body as Body }
}

test('an invalid body gets 400 invalid_request before anything is read', async () => {
  for (const body of [null, {}, request({ leadIds: [] }), request({ leadIds: Array.from({ length: 501 }, (_, i) => `l${i}`) }),
    request({ leadIds: ['a', 'a'] }), request({ token: 'short' })]) {
    const { res, crm, mem } = await run({ body })
    assert.deepEqual(res, { status: 400, body: { error: 'invalid_request' } })
    assert.equal(crm.calls.length, 0)
    assert.equal(mem.calls.length, 0)
  }
})

test('every refusal does no work and writes nothing: one CRM read, no DealFlow access at all', async () => {
  const ok = { orgSlug: 'dealflow-ryan', status: 'completed', completedAt: new Date(NOW.getTime() - 5 * 60_000), tokenHash: TOKEN_HASH, scoredAt: null }
  const cases: [Row | null, number, string][] = [
    [null, 404, 'not_found'],
    [{ ...ok, orgSlug: 'another-org' }, 404, 'not_found'],
    [{ ...ok, tokenHash: null }, 403, 'bad_token'],
    [{ ...ok, tokenHash: 'f'.repeat(64) }, 403, 'bad_token'],
    [{ ...ok, status: 'importing' }, 403, 'not_completed'],
    [{ ...ok, completedAt: new Date(NOW.getTime() - 60 * 60_000) }, 403, 'expired'],
    [{ ...ok, scoredAt: new Date(NOW.getTime() - 60_000) }, 403, 'already_scored'],
  ]
  for (const [batch, status, error] of cases) {
    const { res, crm, mem } = await run({ batch })
    assert.deepEqual(res, { status, body: { error } }, error)
    assert.deepEqual(crm.calls.map(c => c.sql.includes('"ImportBatch"')), [true], `${error}: only the import lookup`)
    assert.equal(mem.calls.length, 0, `${error}: DealFlow untouched`)
    assert.equal(mem.touched.size, 0, `${error}: DealFlow untouched`)
  }
})

test('only the upload\'s new leads are scored; the others are skipped with a reason, in request order', async () => {
  const { res, body, crm } = await run()
  assert.equal(res.status, 200)
  assert.deepEqual(Object.keys(body), ['importId', 'generatedAt', 'includeTestBuyers', 'ms', 'scored', 'skipped'])
  assert.equal(body.importId, IMPORT_ID)
  assert.equal(body.generatedAt, NOW.toISOString())
  assert.deepEqual(body.scored.map(s => [s.crmLeadId, s.mojoId]), [['lead_new1', '7700001'], ['lead_new2', '7700002'], ['lead_far', '7700003']])
  assert.deepEqual(body.skipped, [
    { crmLeadId: 'lead_nomojo', reason: 'no_mojo_id' },
    { crmLeadId: 'lead_old', reason: 'not_new_in_import' },
    { crmLeadId: 'lead_amb', reason: 'not_copied' },
    { crmLeadId: 'lead_unknown', reason: 'not_new_in_import' },
  ])
  // Every requested id comes back exactly once.
  assert.deepEqual([...body.scored.map(s => s.crmLeadId), ...body.skipped.map(s => s.crmLeadId)].sort(), [...REQUEST_IDS].sort())
  // The new-lead rule is asked of the CRM with this import and exactly the requested ids.
  const asked = crm.calls.find(c => c.sql === NEW_IMPORT_LEADS_SQL)!
  assert.deepEqual(asked.params, [IMPORT_ID, REQUEST_IDS])
})

const SCORED_KEYS = ['crmLeadId', 'mojoId', 'priorityScore', 'queueReason', 'primaryMatchId', 'primaryMatchFit', 'primaryCaptureStatus',
  'primaryMatchConfidence', 'matchReason', 'contributions', 'buyers', 'notRankedReason']
const BUYER_KEYS = ['matchId', 'score', 'tier', 'reasonKeys', 'captureStatus', 'type', 'name', 'brokerage', 'neighborhoods', 'propertyTypes',
  'bedsMin', 'bedsMax', 'priceMin', 'priceMax', 'buyerArchetype', 'isTestData']

test('response fields: call priority as the morning list computes it, the primary match, and up to 5 buyers (no phone, no email)', async () => {
  const { body, mem } = await run()
  for (const s of body.scored) assert.deepEqual(Object.keys(s), SCORED_KEYS, String(s.crmLeadId))
  const sellerOf = (mojoId: unknown) => mem.data.mojoContact.find(c => c.mojoId === mojoId)!
  for (const id of ['lead_new1', 'lead_new2']) {
    const s = body.scored.find(x => x.crmLeadId === id)!
    assert.equal(s.notRankedReason, null, id)
    assert.ok(Number.isInteger(s.priorityScore) && (s.priorityScore as number) >= 0 && (s.priorityScore as number) <= 100, id)
    assert.equal(typeof s.queueReason, 'string')
    const primary = mem.data.match.find(m => m.id === s.primaryMatchId)!
    assert.equal(primary.opportunityId, sellerOf(s.mojoId).id, `${id}: the primary match is this seller's`)
    assert.equal(s.primaryMatchFit, primary.score)
    assert.equal(s.primaryCaptureStatus, primary.captureStatus)
    assert.equal(s.primaryMatchConfidence, primary.matchFitConfidence)
    assert.equal(s.matchReason, primary.reason)
    // The best match of this seller is the primary one.
    const best = Math.max(...mem.data.match.filter(m => m.opportunityId === primary.opportunityId).map(m => m.score as number))
    assert.equal(s.primaryMatchFit, best)
    const buyers = s.buyers as Row[]
    assert.ok(buyers.length >= 1 && buyers.length <= 5, `${id}: ${buyers.length} buyers`)
    for (const b of buyers) {
      assert.deepEqual(Object.keys(b), BUYER_KEYS)
      assert.ok(!/phone|email/i.test(JSON.stringify(Object.keys(b))))
      assert.ok(!JSON.stringify(b).includes('agent@example.com'), 'no agent email rides along')
    }
    assert.deepEqual(buyers.map(b => b.score), [...buyers.map(b => b.score)].sort((a, b) => (b as number) - (a as number)), 'best first')
    assert.equal(typeof s.contributions, 'object')
  }
  // The Staten Island seller has no buyer: not ranked, for the hard filter's reason.
  const far = body.scored.find(x => x.crmLeadId === 'lead_far')!
  assert.deepEqual(far, {
    crmLeadId: 'lead_far', mojoId: '7700003', priorityScore: null, queueReason: null, primaryMatchId: null, primaryMatchFit: null,
    primaryCaptureStatus: null, primaryMatchConfidence: null, matchReason: null, contributions: null, buyers: [], notRankedReason: 'no_matches',
  })
})

test('buyers are whitelisted to the CRM\'s DealflowBuyer fields, at most 5', async () => {
  const mem = memoryDb(dealflowWorld(), (sql, params, _kind, data) => {
    const out = importRaw(data as unknown as Record<string, Row[]>)(sql, params)
    if (Array.isArray(out) && out[0] && 'buyers' in (out[0] as Row)) {
      for (const r of out as Row[]) {
        const b = (r.buyers as Row[])[0]
        if (b) r.buyers = Array.from({ length: 7 }, (_, i) => ({ ...b, matchId: `${b.matchId}_${i}`, phone: '7185550199', sourceAgentEmail: 'x@example.com' }))
      }
    }
    return out
  })
  const { body } = await run({ mem })
  const s = body.scored.find(x => x.crmLeadId === 'lead_new1')!
  assert.equal((s.buyers as Row[]).length, 5)
  for (const b of s.buyers as Row[]) assert.deepEqual(Object.keys(b), BUYER_KEYS)
})

test('the lead copy covers only these new leads; duplicate decisions are taken over the whole CRM read; no removed/legacy marking', async () => {
  const { mem, crm } = await run()
  assert.deepEqual(crm.calls.filter(c => c.sql === 'readCrmLeads').map(c => c.params), [['dealflow-ryan']])
  const upserts = mem.calls.filter(c => c.sql === UPSERT_SQL)
  assert.equal(upserts.length, 1)
  assert.deepEqual((JSON.parse(upserts[0].params![0] as string) as Row[]).map(r => r.mojoId).sort(), ['7700001', '7700002', '7700003'])
  assert.equal(upserts[0].params![1], 'org_df')
  // lead_rekey's csv copy would be re-keyed by the nightly; not by this path.
  assert.deepEqual(mem.calls.filter(c => c.sql === REKEY_SQL).map(c => JSON.parse(c.params![0] as string)), [[]])
  assert.ok(mem.data.mojoContact.some(c => c.id === 'csv_rekey' && c.mojoId === 'csv_901'))
  // Duplicate marks: only the ones whose keeper is this upload's lead (lead_rekey's twin is the nightly's job).
  assert.deepEqual(mem.calls.filter(c => c.sql === DUPLICATES_SQL).map(c => JSON.parse(c.params![0] as string)), [[{ id: 'csv_new1_twin', keeper_id: 's_new1' }]])
  // lead_other (new to DealFlow, not in this upload) was not copied.
  assert.ok(!mem.data.mojoContact.some(c => c.mojoId === '7700007'))
  for (const sql of [REMOVED_SQL, LEGACY_SQL]) assert.ok(!mem.calls.some(c => c.sql === sql))
  // Writes ran inside transactions that committed.
  assert.ok(mem.writes().filter(c => c.model !== 'auditLog').every(c => c.tx !== null))
  assert.ok(mem.txs.every(t => t.outcome === 'commit'))
})

test('keep-old rule [Ryan, Brief 34]: a changed existing value rolls the copy back, and scoring never runs', async () => {
  const mem = memoryDb(dealflowWorld(), (sql, params, _kind, data) => {
    if (sql === UPSERT_SQL) {
      return [{ mojoId: '7700001', inserted: false, before: { status: 'Earlier status', phone: '7185550160' }, after: { status: 'New lead', phone: '7185550160' } }]
    }
    return importRaw(data as unknown as Record<string, Row[]>)(sql, params)
  })
  const { res } = await run({ mem })
  assert.deepEqual(res, { status: 500, body: { error: 'scoring_failed' } })
  assert.deepEqual(mem.txs.map(t => t.outcome), ['rollback'])
  assert.ok(!mem.calls.some(c => c.sql === UPSERT_MATCHES_SQL))
  assert.equal(mem.data.auditLog.length, 0)
})

test('Match rows are written for these sellers only, and stale rows are deleted for these sellers only', async () => {
  const { mem } = await run()
  const mine = new Set(['7700001', '7700002', '7700003'].map(m => mem.data.mojoContact.find(c => c.mojoId === m)!.id as string))
  assert.ok(mine.has('s_new1')) // the earlier copy kept its id
  const upserts = mem.calls.filter(c => c.sql === UPSERT_MATCHES_SQL)
  const rows = upserts.flatMap(c => JSON.parse(c.params![0] as string) as Row[])
  assert.ok(rows.length > 0)
  assert.ok(rows.every(r => mine.has(r.opportunityId as string)))
  assert.ok(!rows.some(r => r.opportunityId === 's_new1' && r.counterpartId === 'b_iso7'), 'a dismissed pair is never kept')
  assert.ok(!mem.calls.some(c => c.sql === DELETE_STALE_MATCHES_SQL), 'never the whole-org delete')
  const del = mem.calls.filter(c => c.sql === DELETE_STALE_MATCHES_OF_SELLERS_SQL)
  assert.equal(del.length, 1)
  assert.equal(del[0].params![0], 'org_df')
  assert.deepEqual((JSON.parse(del[0].params![2] as string) as string[]).sort(), [...mine].sort())
  assert.equal(JSON.parse(del[0].params![1] as string).length, rows.length)
  assert.equal(del[0].tx, upserts[0].tx, 'upsert and delete share one transaction')
  assert.ok(mem.data.match.some(m => m.id === 'm_old1'), "another seller's row survives")
  assert.ok(!mem.data.match.some(m => m.id === 'm_stale_new1'), "this seller's stale row is gone")
})

test('no CallQueueEntry: the path never touches the model, no statement names the table, and the list is unchanged', async () => {
  const { mem, res } = await run()
  assert.equal(res.status, 200)
  assert.ok(!mem.touched.has('callQueueEntry'))
  assert.ok(!mem.calls.some(c => /CallQueueEntry/i.test(c.sql ?? '')))
  assert.equal(mem.data.callQueueEntry.length, 0)
})

test("the route's code never references the call-list writer", () => {
  const root = join(__dirname, '..', '..', '..')
  const files = [
    'app/api/crm/score-import/route.ts',
    ...readdirSync(join(root, 'lib/importScoring')).filter(f => f.endsWith('.ts')).map(f => `lib/importScoring/${f}`),
  ]
  assert.ok(files.length >= 5, files.join(', '))
  for (const f of files) {
    const code = readFileSync(join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    assert.ok(!/callQueueEntry|CallQueueEntry|persistBatch|buildCallQueue/.test(code), f)
  }
})

test('one AuditLog row, CRM_IMPORT_SCORING, with counts only', async () => {
  const { mem } = await run()
  const audits = mem.data.auditLog
  assert.equal(audits.length, 1)
  assert.equal(audits[0].action, 'CRM_IMPORT_SCORING')
  assert.equal(audits[0].organizationId, 'org_df')
  const leaves = (v: unknown): unknown[] => (v && typeof v === 'object' ? Object.values(v).flatMap(leaves) : [v])
  const details = audits[0].detailsJson as Row
  assert.ok(leaves(details).every(v => typeof v === 'number' || typeof v === 'boolean'), JSON.stringify(details))
  assert.equal(details.requested, REQUEST_IDS.length)
  assert.equal(details.scored, 3)
  assert.equal(details.ranked, 2)
})

test('SCORING_INCLUDE_TEST_BUYERS: test buyers count as demand only when it is exactly "true"', async () => {
  delete process.env.SCORING_INCLUDE_TEST_BUYERS
  assert.equal((await run()).body.includeTestBuyers, false)
  process.env.SCORING_INCLUDE_TEST_BUYERS = 'true'
  assert.equal((await run()).body.includeTestBuyers, true)
  process.env.SCORING_INCLUDE_TEST_BUYERS = 'TRUE'
  assert.equal((await run()).body.includeTestBuyers, false)
  delete process.env.SCORING_INCLUDE_TEST_BUYERS
})

test('when no requested lead is new with a Mojo ID, nothing is read or written except the audit row', async () => {
  const { res, body, mem, crm } = await run({ body: request({ leadIds: ['lead_nomojo', 'lead_old'] }) })
  assert.equal(res.status, 200)
  assert.deepEqual(body.scored, [])
  assert.deepEqual(body.skipped.map(s => s.reason), ['no_mojo_id', 'not_new_in_import'])
  assert.ok(!crm.calls.some(c => c.sql === 'readCrmLeads'))
  assert.deepEqual(mem.writes().map(c => `${c.model}.${c.op}`), ['auditLog.create'])
})

test('a failed step returns 500 scoring_failed with no details, and an empty CRM read writes nothing', async () => {
  const s = setup()
  s.deps.readCrmLeads = async () => { throw new Error('connection to 10.0.0.1 refused') }
  assert.deepEqual(await scoreImport(request(), s.deps), { status: 500, body: { error: 'scoring_failed' } })
  assert.deepEqual(s.mem.writes(), [])
  const e = setup()
  e.deps.readCrmLeads = async () => []
  assert.deepEqual(await scoreImport(request(), e.deps), { status: 500, body: { error: 'scoring_failed' } })
  assert.deepEqual(e.mem.writes(), [])
})

// CI has no database, so the two CRM reads' rules are pinned here too (the DB
// test checks what they do): this organization, this upload's new leads only,
// and UTC instants from the CRM's timestamp-without-time-zone columns.
test('the CRM reads keep the organization, the new-lead rule and UTC times', () => {
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
  assert.equal(flat(NEW_IMPORT_LEADS_SQL), 'SELECT l.id, l."mojoId" FROM "ImportBatch" b JOIN "Lead" l ON l."organizationId" = b."organizationId" ' +
    'AND l.source = \'import:\' || b.id AND l."createdAt" >= b."createdAt" WHERE b.id = $1 AND l.id = ANY($2::text[])')
  assert.equal(flat(IMPORT_BATCH_SQL), 'SELECT o.slug AS "orgSlug", b.status, b."completedAt" AT TIME ZONE \'UTC\' AS "completedAt", ' +
    'b."dealflowScoreTokenHash" AS "tokenHash", b."dealflowScoredAt" AT TIME ZONE \'UTC\' AS "scoredAt" ' +
    'FROM "ImportBatch" b JOIN "Organization" o ON o.id = b."organizationId" WHERE b.id = $1')
})

// Brief 47 (PR 4): the two public debug routes, on an in-memory stand-in for Prisma
// (no database, no network). GET /api/debug/health is never cached, no longer reads the
// retired Zapier log, shows the status window and only reads; GET /api/debug/guard-fires
// shows 50 events when ?limit is missing or not a number. Runs under tsx; every row is
// invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

type Row = Record<string, unknown>
type Handler = (args: Row) => unknown

// lib/prisma uses globalThis.prisma when it is set, so no database client is created.
// The routes are imported inside the tests, after this runs.
const touched = new Set<string>()
const calls: Array<{ model: string; op: string; args: Row }> = []
let auditRows: Array<{ action: string; createdAt: Date; detailsJson: unknown }> = []
const handlers: Record<string, Record<string, Handler>> = {
  organization: { findUnique: () => ({ id: 'org-test' }) },
  auditLog: {
    findFirst: ({ where }) => {
      const action = (where as Row).action
      const hit = (a: string) => (typeof action === 'string' ? a === action
        : Array.isArray((action as Row).in) ? ((action as Row).in as string[]).includes(a)
        : a.includes(String((action as Row).contains)))
      const newest = auditRows.filter(r => hit(r.action)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
      return newest ?? null
    },
  },
  featureFlag: { findUnique: () => ({ enabled: true }) },
  rapidApiUsage: { findUnique: () => ({ callsConsumed: 12 }) },
}
const DEFAULTS: Record<string, unknown> = { findMany: [], findFirst: null, findUnique: null, count: 0, groupBy: [] }
;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy({}, {
  get: (_t, model) => {
    if (typeof model !== 'string') return undefined
    touched.add(model)
    return new Proxy({}, {
      get: (_u, op) => typeof op !== 'string' ? undefined : async (args: Row = {}) => {
        calls.push({ model, op, args })
        const h = handlers[model]?.[op]
        if (h) return h(args)
        if (!(op in DEFAULTS)) throw new Error(`stand-in: ${model}.${op} is not a read`)
        return DEFAULTS[op]
      },
    })
  },
})

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { error } = console
  console.error = () => {}
  try { return await fn() } finally { console.error = error }
}

async function health() {
  auditRows = [
    { action: 'NIGHTLY_SCORING', createdAt: new Date('2026-10-19T09:02:00Z'), detailsJson: { sellers: 1498, buyers: 250, kept: 8213, tiers: { HOT: 812 } } },
  ]
  touched.clear()
  calls.length = 0
  const { GET } = await import('../health/route')
  const res = await quiet(() => GET())
  return { res, body: await res.json() as Row }
}

test('GET /api/debug/health is never cached', async () => {
  const { res } = await health()
  assert.equal(res.headers.get('cache-control'), 'no-store')
})

test('GET /api/debug/health: the retired Zapier block is gone, the other blocks are kept', async () => {
  const { body } = await health()
  assert.ok(!('recentIngest' in body), 'no recentIngest')
  assert.ok(!touched.has('zapierIngestLog'), 'the Zapier log is not read')
  // Brief 48 (PR 16, Revision 1): orgId (an internal id) is gone; the older blocks
  // show counts and times only (healthOlderSections.unit.test.ts).
  assert.ok(!('orgId' in body), 'no orgId')
  for (const k of ['flags', 'graphToken', 'lastSync', 'recentMatches', 'recentDismissals', 'recentPush', 'subsystemLastSuccess']) {
    assert.ok(k in body, `existing block ${k} kept`)
  }
})

test('GET /api/debug/health shows the status window and only reads', async () => {
  const { body } = await health()
  for (const k of ['lastNight', 'valuationSwitch', 'switches', 'rapidApi']) assert.ok(k in body, `new block ${k}`)
  const lastNight = body.lastNight as Row
  assert.equal((lastNight.scoring as Row).finishedAt, '2026-10-19T09:02:00.000Z')
  assert.deepEqual((lastNight.scoring as Row).tiers, { HOT: 812, WARM: 0, POSSIBLE: 0 })
  assert.equal(lastNight.crmLeadSync, null)
  assert.equal((body.valuationSwitch as Row).useOurEstimates, true)
  assert.equal((body.rapidApi as Row).calls, 12)
  for (const c of calls) assert.match(c.op, /^(findFirst|findUnique|findMany|count|groupBy)$/, `${c.model}.${c.op}`)
})

test('GET /api/debug/guard-fires: 50 when ?limit is missing, empty or not a number; 1..500 otherwise', async () => {
  const { GET } = await import('../guard-fires/route')
  const take = async (qs: string) => {
    calls.length = 0
    const res = await quiet(() => GET(new NextRequest(`https://dealflow.example/api/debug/guard-fires${qs}`)))
    assert.equal(res.status, 200)
    const find = calls.find(c => c.model === 'guardFireEvent' && c.op === 'findMany')
    assert.ok(find, qs)
    return find.args.take
  }
  assert.equal(await take(''), 50)
  assert.equal(await take('?limit='), 50)
  assert.equal(await take('?limit=abc'), 50)
  assert.equal(await take('?limit=0'), 1)
  assert.equal(await take('?limit=-5'), 1)
  assert.equal(await take('?limit=9999'), 500)
  assert.equal(await take('?limit=25'), 25)
  assert.equal(await take('?limit=2.5'), 2) // Prisma's take must be a whole number
})

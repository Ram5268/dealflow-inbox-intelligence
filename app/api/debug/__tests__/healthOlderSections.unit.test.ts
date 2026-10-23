// Brief 48 (PR 16, Revision 1): the status page's older sections (GET /api/debug/health)
// show counts and times only, never internal ids, and "last sync" counts only the CRM
// copy (CRM_LEAD_SYNC) and the background sync (BACKGROUND_SYNC), not any action with
// "SYNC" in its name [planner, Brief 48 Revision 1; engineering precaution: the page is
// public]. Runs under tsx on an in-memory stand-in for Prisma (no database, no network).
// Every row and id is invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'

type Row = Record<string, unknown>
const HOUR = 60 * 60 * 1000
const ago = (h: number) => new Date(Date.now() - h * HOUR)

const tables: Record<string, Row[]> = {}
function reset() {
  tables.organization = [{ id: 'org-fake-7f3a', slug: 'dealflow-ryan' }]
  tables.connectedMailbox = []
  tables.match = [
    { id: 'match-fake-001', score: 91, tier: 'HOT', counterpartType: 'opportunity', createdAt: ago(1) },
    { id: 'match-fake-002', score: 70, tier: 'WARM', counterpartType: 'opportunity', createdAt: ago(30) },
    { id: 'match-fake-003', score: 66, tier: 'WARM', counterpartType: 'mojo', createdAt: ago(72) },
    { id: 'match-fake-004', score: 50, tier: null, counterpartType: 'mojo', createdAt: ago(9 * 24) },
  ]
  tables.matchDismissal = [
    { id: 'dismissal-fake-001', partyId: 'party-fake-001', listingId: 'listing-fake-001', dismissalReason: 'NOT_A_FIT', dismissedAt: ago(2) },
    { id: 'dismissal-fake-002', partyId: 'party-fake-002', listingId: 'listing-fake-002', dismissalReason: null, dismissedAt: ago(10 * 24) },
  ]
  tables.extractedOpportunity = [{ id: 'opp-fake-001', createdAt: ago(2) }]
  tables.auditLog = [
    { id: 'audit-fake-1', action: 'PUSH_SENT', createdAt: ago(1), detailsJson: { kind: 'realtime', matchId: 'match-fake-001', delivered: 1, at: ago(1).toISOString() } },
    { id: 'audit-fake-2', action: 'PUSH_SENT', createdAt: ago(5 * 24), detailsJson: { kind: 'digest', matchCount: 3, delivered: 0 } },
    { id: 'audit-fake-3', action: 'PUSH_SENT', createdAt: ago(20 * 24), detailsJson: { kind: 'test' } },
    { id: 'audit-fake-4', action: 'CRM_LEAD_SYNC', createdAt: ago(10), detailsJson: { crmLeads: 3 } },
    { id: 'audit-fake-5', action: 'BACKGROUND_SYNC', createdAt: ago(40 * 24), detailsJson: {} },
    // An older job's name that also has "SYNC" in it, newer than both: not a sync.
    { id: 'audit-fake-6', action: 'MOJO_SYNC', createdAt: ago(0.5), detailsJson: {} },
  ]
  tables.featureFlag = []
  tables.rapidApiUsage = []
}

// A small, honest stand-in: where (equals, contains, in, gte), orderBy one field,
// take, and select. Anything that writes throws.
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k]
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as Row
      if ('contains' in c && !(typeof v === 'string' && v.includes(String(c.contains)))) return false
      if ('in' in c && !(c.in as unknown[]).includes(v)) return false
      if ('gte' in c && !(v instanceof Date && v.getTime() >= (c.gte as Date).getTime())) return false
      return true
    }
    return v === cond
  })
}
function query(model: string, args: Row = {}): Row[] {
  let rows = (tables[model] ?? []).filter(r => matches(r, args.where as Row))
  const order = args.orderBy as Record<string, 'asc' | 'desc'> | undefined
  if (order) {
    const [[field, dir]] = Object.entries(order)
    rows = [...rows].sort((a, b) => ((a[field] as Date).getTime() - (b[field] as Date).getTime()) * (dir === 'desc' ? -1 : 1))
  }
  if (typeof args.take === 'number') rows = rows.slice(0, args.take)
  const select = args.select as Record<string, boolean> | undefined
  return select ? rows.map(r => Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, r[k]]))) : rows
}
const ops: string[] = []
;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy({}, {
  get: (_t, model) => typeof model !== 'string' ? undefined : new Proxy({}, {
    get: (_u, op) => typeof op !== 'string' ? undefined : async (args: Row = {}) => {
      ops.push(`${model}.${op}`)
      if (op === 'findMany') return query(model, args)
      if (op === 'findFirst' || op === 'findUnique') return query(model, args)[0] ?? null
      if (op === 'count') return query(model, { where: args.where }).length
      if (op === 'groupBy') return []
      throw new Error(`stand-in: ${model}.${op} is not a read`)
    },
  }),
})

async function health() {
  ops.length = 0
  const { GET } = await import('../health/route')
  const { error } = console
  console.error = () => {}
  try {
    return await (await GET()).json() as Row
  } finally { console.error = error }
}

test('the older sections show no internal ids', async () => {
  reset()
  const body = await health()
  const text = JSON.stringify(body)
  for (const id of ['org-fake', 'match-fake', 'party-fake', 'listing-fake', 'dismissal-fake', 'opp-fake', 'audit-fake']) {
    assert.ok(!text.includes(id), `no ${id}… in the reply`)
  }
  assert.ok(!('orgId' in body), 'the organization id is not shown')
})

test('recent matches, dismissals and phone notifications are counts and times', async () => {
  reset()
  const body = await health()
  assert.deepEqual(body.recentMatches, { newestAt: (tables.match[0].createdAt as Date).toISOString(), last24h: 1, last7d: 3 })
  assert.deepEqual(body.recentDismissals, { newestAt: (tables.matchDismissal[0].dismissedAt as Date).toISOString(), last24h: 1, last7d: 1 })
  // The realtime push reached a device; the digest 5 days ago reached none; the test
  // push 20 days ago is outside the 7 days.
  assert.deepEqual(body.recentPush, { newestAt: (tables.auditLog[0].createdAt as Date).toISOString(), last24h: 1, last7d: 2, last7dDelivered: 1 })
  // Every value in these blocks is a time (ISO text), a count, or unknown (null).
  for (const k of ['recentMatches', 'recentDismissals', 'recentPush']) {
    for (const [field, v] of Object.entries(body[k] as Row)) {
      assert.ok(v === null || typeof v === 'number' || (typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v)), `${k}.${field}`)
    }
  }
})

test('nothing yet: the counts are 0 and the times are empty', async () => {
  reset()
  tables.match = []; tables.matchDismissal = []; tables.auditLog = []
  const body = await health()
  assert.deepEqual(body.recentMatches, { newestAt: null, last24h: 0, last7d: 0 })
  assert.deepEqual(body.recentDismissals, { newestAt: null, last24h: 0, last7d: 0 })
  assert.deepEqual(body.recentPush, { newestAt: null, last24h: 0, last7d: 0, last7dDelivered: 0 })
})

test('"last sync" is the newer of the CRM copy and the background sync, nothing else', async () => {
  reset()
  let body = await health()
  assert.equal((body.lastSync as Row).at, (tables.auditLog[3].createdAt as Date).toISOString(), 'the CRM copy, not MOJO_SYNC')
  // The background sync runs later than the CRM copy: it wins.
  tables.auditLog[4].createdAt = ago(3)
  body = await health()
  assert.equal((body.lastSync as Row).at, (tables.auditLog[4].createdAt as Date).toISOString(), 'the background sync')
  // Neither has ever run: no time, even though a listing and a MOJO_SYNC row exist.
  tables.auditLog = tables.auditLog.filter(r => r.action !== 'CRM_LEAD_SYNC' && r.action !== 'BACKGROUND_SYNC')
  body = await health()
  assert.equal((body.lastSync as Row).at, null)
  assert.equal((body.lastSync as Row).opportunitiesCreated, 1)
  assert.equal((body.lastSync as Row).matchesCreated, 1)
})

test('the route only reads', async () => {
  reset()
  await health()
  for (const op of ops) assert.match(op, /\.(findFirst|findUnique|findMany|count|groupBy)$/, op)
})

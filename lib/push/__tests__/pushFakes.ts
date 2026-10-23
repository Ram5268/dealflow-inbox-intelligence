// Brief 48 (PR 5): stand-ins for the push tests. An in-memory Prisma for the tables
// the push code touches, and web-push with its sender replaced, so nothing is ever
// sent and no database or network is reached. Import this FIRST in a test file:
// lib/prisma uses globalThis.prisma when it is set, so no database client is ever
// created (as app/api/matches/__tests__/byId.test.ts does). Every name, address,
// phone number and device here is invented.
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import webpush from 'web-push'

export const ORG = 'org-b48-pr5'
export const OTHER_ORG = 'org-b48-other'

export type Row = Record<string, unknown>
type Where = Record<string, unknown>
type Order = Record<string, 'asc' | 'desc'>
type Args = {
  where?: Where; select?: Record<string, boolean>; orderBy?: Order | Order[]; take?: number; distinct?: string[]
  data?: Row; create?: Row; update?: Row
}

export const db = {
  tables: {} as Record<string, Row[]>,
  calls: [] as Array<{ model: string; op: string; args: Args }>,
}
// Every push the fake sender was handed (installFakeWebPush), in order.
export const sent: Array<{ endpoint: string; title: string; body: string; url?: string }> = []

// Fresh tables for one case. The singleton organization is always there.
export function resetDb(tables: Record<string, Row[]> = {}) {
  db.tables = { organization: [{ id: ORG, slug: 'dealflow-ryan' }], ...tables }
  db.calls.length = 0
  sent.length = 0
}

const TIER_RANK: Record<string, number> = { HOT: 0, WARM: 1, POSSIBLE: 2 } // Postgres enum order
const scalar = (v: unknown) => (v instanceof Date ? v.getTime() : v)

function fits(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some(w => fits(row, w))
    if (key === 'AND') return (cond as Where[]).every(w => fits(row, w))
    const v = row[key]
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) return scalar(v) === scalar(cond)
    const c = cond as Row
    for (const op of Object.keys(c)) {
      if (!['gte', 'not', 'in', 'path', 'equals'].includes(op)) throw new Error(`stand-in: where.${key}.${op} is not supported`)
    }
    if ('path' in c) {
      let x: unknown = v
      for (const p of c.path as string[]) x = x && typeof x === 'object' ? (x as Row)[p] : undefined
      return x === c.equals
    }
    if ('equals' in c) return scalar(v) === scalar(c.equals)
    if ('gte' in c && !((scalar(v) as number) >= (scalar(c.gte) as number))) return false
    if ('not' in c && scalar(v) === scalar(c.not)) return false
    if ('in' in c && !(c.in as unknown[]).includes(v)) return false
    return true
  })
}

function sorter(orderBy?: Order | Order[]) {
  const list = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : []
  return (a: Row, b: Row) => {
    for (const o of list) {
      const [k, dir] = Object.entries(o)[0]
      const key = (r: Row) => (k === 'tier' ? (r[k] == null ? 99 : TIER_RANK[r[k] as string]) : scalar(r[k])) as number | string
      const x = key(a), y = key(b)
      if (x !== y) return (x < y ? -1 : 1) * (dir === 'asc' ? 1 : -1)
    }
    return 0
  }
}

const pick = (r: Row, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, r[k]])) : { ...r }
const notFound = () => Object.assign(new Error('stand-in: record not found'), { code: 'P2025' })
// Each call waits a turn first, so requests that run together interleave the way
// they would against a real database.
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

let seq = 0
function model(name: string) {
  const rows = () => (db.tables[name] ??= [])
  const call = async (op: string, args: Args) => { db.calls.push({ model: name, op, args }); await turn() }
  const fresh = (data: Row = {}): Row => {
    if (name === 'pushSubscription' && rows().some(r => r.endpoint === data.endpoint)) {
      throw Object.assign(new Error('stand-in: unique endpoint'), { code: 'P2002' })
    }
    const r = { id: `${name}-${++seq}`, createdAt: new Date(), ...data }
    rows().push(r)
    return r
  }
  return {
    async findUnique(args: Args) {
      await call('findUnique', args)
      const r = rows().find(x => fits(x, args.where))
      return r ? pick(r, args.select) : null
    },
    async findFirst(args: Args = {}) {
      await call('findFirst', args)
      const r = rows().filter(x => fits(x, args.where)).sort(sorter(args.orderBy))[0]
      return r ? pick(r, args.select) : null
    },
    async findMany(args: Args = {}) {
      await call('findMany', args)
      let out = rows().filter(x => fits(x, args.where)).sort(sorter(args.orderBy))
      if (args.distinct) {
        const seen = new Set<string>()
        out = out.filter(r => { const k = args.distinct!.map(d => String(r[d])).join('|'); return seen.has(k) ? false : (seen.add(k), true) })
      }
      if (args.take != null) out = out.slice(0, args.take)
      return out.map(r => pick(r, args.select))
    },
    async count(args: Args = {}) {
      await call('count', args)
      return rows().filter(x => fits(x, args.where)).length
    },
    async create(args: Args) {
      await call('create', args)
      return pick(fresh(args.data), args.select)
    },
    async update(args: Args) {
      await call('update', args)
      const r = rows().find(x => fits(x, args.where))
      if (!r) throw notFound()
      Object.assign(r, args.data)
      return pick(r, args.select)
    },
    async updateMany(args: Args) {
      await call('updateMany', args)
      const hits = rows().filter(x => fits(x, args.where))
      for (const r of hits) Object.assign(r, args.data)
      return { count: hits.length }
    },
    async upsert(args: Args) {
      await call('upsert', args)
      const r = rows().find(x => fits(x, args.where))
      if (r) { Object.assign(r, args.update); return pick(r, args.select) }
      return pick(fresh(args.create), args.select)
    },
    async delete(args: Args) {
      await call('delete', args)
      const i = rows().findIndex(x => fits(x, args.where))
      if (i < 0) throw notFound()
      return rows().splice(i, 1)[0]
    },
    async deleteMany(args: Args = {}) {
      await call('deleteMany', args)
      const keep = rows().filter(x => !fits(x, args.where))
      const count = rows().length - keep.length
      db.tables[name] = keep
      return { count }
    },
  }
}

;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy({}, {
  get: (_t, name) => (typeof name === 'string' && name !== 'then' ? model(name) : undefined),
})

// No real network, ever: any HTTP request or fetch fails the test.
const refuse = () => { throw new Error('stand-in: network refused in tests') }
;(http as unknown as Row).request = refuse
;(https as unknown as Row).request = refuse
globalThis.fetch = (async () => refuse()) as unknown as typeof fetch

// web-push with its sender replaced: each push is recorded in `sent` instead.
export function installFakeWebPush() {
  // Placeholder values for this test process only, never real keys.
  process.env.VAPID_PUBLIC_KEY = 'b48-test-public-placeholder'
  process.env.VAPID_PRIVATE_KEY = 'b48-test-private-placeholder'
  const wp = webpush as unknown as Row
  wp.setVapidDetails = () => {}
  wp.sendNotification = async (sub: { endpoint: string }, payload: string) => {
    sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) })
    return { statusCode: 201, body: '', headers: {} }
  }
}

// Invented people, homes and numbers the push text must never carry.
export const FICTIONAL = {
  names: ['Morgan Madeup', 'Avery Notreal', 'Quinn Fictional', 'Robin Placeholder', 'Sam Inventedname'],
  addresses: ['742 Fictional Blvd', '31 Imaginary Ln', '19 Pretend Pl'],
  phones: ['(718) 555-0142', '917.555.0123', '347-555-0199', '(718) 555-0167', '646 555 0188'],
  neighborhoods: ['Bushwick', 'Crown Heights', 'Park Slope'],
}

export function assertNoPrivateDetails(text: string, label: string) {
  const parts = [
    ...FICTIONAL.names.flatMap(n => [n, ...n.split(' ')]),
    ...FICTIONAL.addresses.flatMap(a => [a, a.replace(/^\d+ /, '')]),
    ...FICTIONAL.phones,
    ...FICTIONAL.neighborhoods,
  ]
  for (const p of parts) assert.ok(!text.includes(p), `${label} carries "${p}": ${text}`)
  assert.ok(!/\d{10}/.test(text), `${label} has a run of 10 digits: ${text}`)
  assert.ok(!/\d{10}/.test(text.replace(/[\s.\-()[\]]/g, '')), `${label} has a run of 10 digits once spaces, dots, dashes and brackets go: ${text}`)
}

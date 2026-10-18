// Brief 44 test helper: an in-memory stand-in for the Prisma calls the valuation
// code makes. No database.
//
// Filters: equality (dates by value), in / notIn / not / lt / gt, the metadata
// JSON-path filter and a PropertyValuation's `run` relation filter. orderBy sorts
// as Postgres does: a null counts as larger than any value, so it comes first in a
// descending sort unless `nulls: 'last'` is asked for. Also distinct, select,
// count, create / createMany / update / updateMany / upsert / deleteMany, and
// unique keys (a clash throws P2002, as Prisma does).
//
// Interactive transactions behave like Postgres's (READ COMMITTED) where the tests
// need it:
//   - a write to a ValuationRun row takes that row's lock until its transaction
//     ends; another writer of the same row waits, then re-checks its filter on the
//     row as it is by then;
//   - a transaction whose callback throws is rolled back;
//   - pauseAfter() holds one call just after it ran, so a test can send another
//     request in between (the lock-ordering tests).
// Unlike Postgres, reads never wait and see other transactions' writes at once;
// no test depends on that.

type Row = Record<string, unknown>
type Where = Record<string, unknown>
type Select = Record<string, boolean>
type Dir = 'asc' | 'desc'
type OrderBy = Record<string, Dir | { sort: Dir; nulls?: 'first' | 'last' }>
type Relations = Record<string, (row: Row) => Row | undefined>

export interface Op {
  table: string
  method: string
  tx: number | null // the transaction it ran in; null when on its own
}

const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b)
const ord = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number | string))
const keyOf = (v: unknown) => (v instanceof Date ? `d${v.getTime()}` : `${typeof v}:${String(v)}`)

// A where clause, compiled once per call (lists become sets).
function compile(where: Where = {}, relations: Relations = {}): (row: Row | undefined) => boolean {
  const tests = Object.entries(where).map(([k, cond]): ((row: Row) => boolean) => {
    if (relations[k]) {
      const c = cond as Where
      const inner = compile(('is' in c ? c.is : c) as Where)
      return row => inner(relations[k](row))
    }
    if (k === 'metadata' && cond && typeof cond === 'object' && 'path' in cond) {
      const c = cond as { path: string[]; equals: unknown }
      return row => {
        let cur: unknown = row[k]
        for (const p of c.path) cur = cur && typeof cur === 'object' ? (cur as Row)[p] : undefined
        return cur === c.equals
      }
    }
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; notIn?: unknown[]; not?: unknown; lt?: unknown; gt?: unknown }
      const inSet = c.in ? new Set(c.in.map(keyOf)) : null
      const notInSet = c.notIn ? new Set(c.notIn.map(keyOf)) : null
      return row => {
        const v = row[k]
        if (inSet && !inSet.has(keyOf(v))) return false
        if (notInSet && notInSet.has(keyOf(v))) return false
        // SQL: "x <> value" is never true for a null x.
        if ('not' in c && (c.not === null ? v == null : v == null || same(v, c.not))) return false
        if (c.lt != null && !(v != null && ord(v) < ord(c.lt))) return false
        if (c.gt != null && !(v != null && ord(v) > ord(c.gt))) return false
        return true
      }
    }
    return row => same(row[k], cond)
  })
  return row => !!row && tests.every(t => t(row))
}

function sorter(orderBy?: OrderBy | OrderBy[]) {
  const list = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : []
  return (a: Row, b: Row) => {
    for (const o of list) {
      const [k, spec] = Object.entries(o)[0]
      const dir = typeof spec === 'string' ? spec : spec.sort
      const nulls = (typeof spec === 'string' ? undefined : spec.nulls) ?? (dir === 'desc' ? 'first' : 'last')
      const x = a[k]
      const y = b[k]
      if (x == null && y == null) continue
      if (x == null) return nulls === 'first' ? -1 : 1
      if (y == null) return nulls === 'first' ? 1 : -1
      if (ord(x) === ord(y)) continue
      return (ord(x) < ord(y) ? -1 : 1) * (dir === 'asc' ? 1 : -1)
    }
    return 0
  }
}

const pick = (row: Row, select?: Select) =>
  select ? Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]])) : { ...row }

// Row locks, held per transaction until it ends.
class Locks {
  private held = new Map<string, number>()
  private waiting: Array<() => void> = []
  async take(name: string, owner: number) {
    while (this.held.has(name) && this.held.get(name) !== owner) await new Promise<void>(wake => this.waiting.push(wake))
    this.held.set(name, owner)
  }
  release(owner: number) {
    for (const [name, o] of [...this.held]) if (o === owner) this.held.delete(name)
    for (const wake of this.waiting.splice(0)) wake()
  }
}

interface TableSpec {
  name: string
  defaults: () => Row
  unique: string[][]
  locked?: boolean // writes take the row lock (ValuationRun)
  relations?: Relations
}
interface Ctx {
  tx: number | null
  undo: Array<() => void> | null
}
interface Env {
  locks: Locks
  ops: Op[]
  afterOp: (op: Op) => Promise<void>
  owner: () => number
  index: (spec: TableSpec, rows: Row[]) => { size: number; sets: Array<Set<string>> }
  stale: (spec: TableSpec) => void
}

function table(spec: TableSpec, rows: Row[], ctx: Ctx, env: Env) {
  const rel = spec.relations ?? {}
  const log = async <T>(method: string, result: T): Promise<T> => {
    const op = { table: spec.name, method, tx: ctx.tx }
    env.ops.push(op)
    await env.afterOp(op)
    return result
  }
  const uniqueKeys = (r: Row) => spec.unique.map(cols => cols.map(c => keyOf(r[c])).join('|'))
  const insert = (data: Row) => {
    const r = { ...spec.defaults(), ...data }
    const ix = env.index(spec, rows)
    const keys = uniqueKeys(r)
    if (keys.some((k, i) => ix.sets[i].has(k))) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    rows.push(r)
    keys.forEach((k, i) => ix.sets[i].add(k))
    ix.size = rows.length
    ctx.undo?.push(() => {
      const at = rows.indexOf(r)
      if (at >= 0) rows.splice(at, 1)
      env.stale(spec)
    })
    return r
  }
  const uniqueCols = new Set(spec.unique.flat())
  const assign = (r: Row, data: Row) => {
    const before = { ...r }
    Object.assign(r, data)
    if (Object.keys(data).some(k => uniqueCols.has(k))) env.stale(spec)
    ctx.undo?.push(() => {
      for (const k of Object.keys(r)) delete r[k]
      Object.assign(r, before)
      env.stale(spec)
    })
  }
  // A write first takes the lock of each row it may change (waiting for another
  // transaction's), then re-checks its filter.
  const lockFor = async (where: Where) => {
    const owner = ctx.tx ?? env.owner()
    if (spec.locked) {
      const candidates = typeof where.id === 'string' ? rows.filter(r => r.id === where.id) : rows.filter(compile(where, rel))
      for (const r of candidates) await env.locks.take(`${spec.name}:${String(r.id)}`, owner)
    }
    const hit = rows.filter(compile(where, rel))
    return { hit, done: () => ctx.tx === null && env.locks.release(owner) }
  }
  return {
    rows,
    findUnique: async (a: { where: Where; select?: Select }) => {
      const r = rows.find(compile(a.where, rel))
      return log('findUnique', r ? pick(r, a.select) : null)
    },
    findFirst: async (a: { where?: Where; orderBy?: OrderBy | OrderBy[]; select?: Select }) => {
      const r = rows.filter(compile(a.where, rel)).sort(sorter(a.orderBy))[0]
      return log('findFirst', r ? pick(r, a.select) : null)
    },
    findMany: async (a: { where?: Where; orderBy?: OrderBy | OrderBy[]; select?: Select; distinct?: string[] } = {}) => {
      let out = rows.filter(compile(a.where, rel)).sort(sorter(a.orderBy))
      if (a.distinct) {
        const seen = new Set<string>()
        out = out.filter(r => {
          const k = a.distinct!.map(c => keyOf(r[c])).join('|')
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
      }
      return log('findMany', out.map(r => pick(r, a.select)))
    },
    count: async (a: { where?: Where } = {}) => log('count', rows.filter(compile(a.where, rel)).length),
    create: async (a: { data: Row }) => log('create', { ...insert(a.data) }),
    createMany: async (a: { data: Row[] }) => {
      for (const d of a.data) insert(d)
      return log('createMany', { count: a.data.length })
    },
    update: async (a: { where: Where; data: Row }) => {
      const { hit, done } = await lockFor(a.where)
      try {
        if (hit.length !== 1) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' })
        assign(hit[0], a.data)
      } finally {
        done()
      }
      return log('update', { ...hit[0] })
    },
    updateMany: async (a: { where: Where; data: Row }) => {
      const { hit, done } = await lockFor(a.where)
      hit.forEach(r => assign(r, a.data))
      done()
      return log('updateMany', { count: hit.length })
    },
    upsert: async (a: { where: Where; create: Row; update: Row }) => {
      const { hit, done } = await lockFor(a.where)
      let r: Row
      try {
        if (hit[0]) assign(hit[0], a.update)
        r = hit[0] ?? insert(a.create)
      } finally {
        done()
      }
      return log('upsert', { ...r })
    },
    deleteMany: async (a: { where: Where }) => {
      const match = compile(a.where, rel)
      const keep: Row[] = []
      const gone: Row[] = []
      for (const r of rows) (match(r) ? gone : keep).push(r)
      rows.length = 0
      rows.push(...keep)
      env.stale(spec)
      ctx.undo?.push(() => {
        rows.push(...gone)
        env.stale(spec)
      })
      return log('deleteMany', { count: gone.length })
    },
  }
}

export const ORG = 'org_b44'
// The tests' "now": the 20th, half an hour after the job's run time below.
export const NOW = new Date('2026-10-20T10:30:00Z')

export function makeFakeDb(now: () => Date = () => NOW) {
  let seq = 0
  const data: Record<string, Row[]> = {
    organization: [{ id: ORG, slug: 'dealflow-ryan' }],
    mojoContact: [],
    valuationRun: [],
    propertyValuation: [],
    serviceKey: [],
  }
  const specs: TableSpec[] = [
    { name: 'organization', defaults: () => ({}), unique: [['id']] },
    { name: 'mojoContact', defaults: () => ({}), unique: [['id']] },
    {
      name: 'valuationRun', unique: [['id']], locked: true,
      defaults: () => ({ published: false, publishedAt: null, createdAt: now(), updatedAt: now() }),
    },
    {
      name: 'propertyValuation', unique: [['id'], ['runId', 'contactId']],
      defaults: () => ({ id: `pv_${++seq}`, createdAt: now() }),
      relations: { run: r => data.valuationRun.find(x => x.id === r.runId) },
    },
    { name: 'serviceKey', unique: [['id']], defaults: () => ({ createdAt: now(), rotatedAt: null }) },
  ]
  // Unique-key indexes: kept in step by inserts, rebuilt after a delete, an undo or
  // a test adding rows itself (the row count no longer matches).
  const indexes = new Map<string, { size: number; sets: Array<Set<string>> }>()
  const pauses: Array<{ when: (op: Op) => boolean; hit: (op: Op) => void; until: Promise<void> }> = []
  const env: Env = {
    locks: new Locks(),
    ops: [],
    owner: () => -++seq,
    afterOp: async op => {
      const at = pauses.findIndex(p => p.when(op))
      if (at < 0) return
      const [p] = pauses.splice(at, 1)
      p.hit(op)
      await p.until
    },
    index: (spec, rows) => {
      let ix = indexes.get(spec.name)
      if (!ix || ix.size !== rows.length) {
        ix = { size: rows.length, sets: spec.unique.map(cols => new Set(rows.map(r => cols.map(c => keyOf(r[c])).join('|')))) }
        indexes.set(spec.name, ix)
      }
      return ix
    },
    stale: spec => indexes.delete(spec.name),
  }
  const tables = (ctx: Ctx) => {
    const [organization, mojoContact, valuationRun, propertyValuation, serviceKey] = specs.map(s => table(s, data[s.name], ctx, env))
    // pg_advisory_xact_lock only: held until the transaction ends, like Postgres's.
    const $executeRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!/pg_advisory_xact_lock/.test(strings.join('?'))) throw new Error('fakeDb: only pg_advisory_xact_lock is supported')
      await env.locks.take(`advisory:${values.map(String).join('|')}`, ctx.tx ?? env.owner())
      const op = { table: 'advisory', method: '$executeRaw', tx: ctx.tx }
      env.ops.push(op)
      await env.afterOp(op)
      return 1
    }
    return { organization, mojoContact, valuationRun, propertyValuation, serviceKey, $executeRaw }
  }
  const txOptions: unknown[] = []
  const db = {
    ...tables({ tx: null, undo: null }),
    ops: env.ops,
    txOptions, // the options each interactive transaction was given
    // Holds the first call that `when` matches, just after it ran, until release().
    pauseAfter(when: (op: Op) => boolean) {
      let hit!: (op: Op) => void
      let release!: () => void
      const reached = new Promise<Op>(r => (hit = r))
      const until = new Promise<void>(r => (release = r))
      pauses.push({ when, hit, until })
      return { reached, release }
    },
    $transaction: async (fn: unknown, options?: unknown) => {
      if (typeof fn !== 'function') return Promise.all(fn as unknown[])
      const id = ++seq
      txOptions.push(options ?? null)
      const ctx: Ctx = { tx: id, undo: [] }
      try {
        return await (fn as (tx: unknown) => unknown)(tables(ctx))
      } catch (e) {
        for (const undo of ctx.undo!.reverse()) undo()
        throw e
      } finally {
        env.locks.release(id)
      }
    },
  }
  return db
}

export type FakeDb = ReturnType<typeof makeFakeDb>

// Lets every waiting call run as far as it can.
export const settle = () => new Promise(resolve => setTimeout(resolve, 20))

// CRM sellers (and one non-CRM contact and one test contact that must never count).
export function seedSellers(db: FakeDb, n: number) {
  for (let i = 0; i < n; i++) {
    db.mojoContact.rows.push({
      id: `c${String(i).padStart(4, '0')}`, organizationId: ORG, isTestData: false, metadata: { source: 'crm', crmLeadId: `lead${i}` },
      fullName: `Homeowner ${i}`, phone: '2125550100', email: 'x@example.com', alternateAddress: '1 Mailing Rd, Elsewhere, FL',
      address: `${100 + i} Example Street`, city: 'Brooklyn', state: 'NY', zipCode: '11216', unitCount: 2, buildingSqft: 2400,
    })
  }
  db.mojoContact.rows.push({ id: 'c_legacy', organizationId: ORG, isTestData: false, metadata: { source: 'legacy' }, address: '9 Old Way' })
  db.mojoContact.rows.push({ id: 'c_test', organizationId: ORG, isTestData: true, metadata: { source: 'crm' }, address: '8 Test Pl' })
}

export const passingChecks = () => [
  { key: 'typical_miss_all', value: 0.103, pass: true },
  { key: 'typical_miss_top8_2to4', value: 0.128, pass: true },
  { key: 'range_coverage', value: 0.667, pass: true },
  { key: 'sellers_valued', value: 1432, pass: true },
]

// Invented dataset versions for the card's sources footer.
export const sources = () => ({
  downloadedOn: '2026-10-18',
  salesThrough: '2026-09-30',
  plutoVersion: '26v2',
  rollFiscalYear: 2027,
  datasets: {
    'usep-8jbt': { updatedOn: '2026-10-15', rows: 21000 },
    '64uk-42ks': { updatedOn: null, rows: 1200 },
    dof_annual: { updatedOn: null, rows: 4 },
  },
})

export function runInput(over: Record<string, unknown> = {}) {
  return {
    runId: 'vr_20261020T100000Z_test01',
    runAt: '2026-10-20T10:00:00Z',
    asOf: '2026-10-01',
    dataThrough: '2026-09-30',
    modelVersion: 'dealflow-gbm90-v1',
    gates: { passed: true, checks: passingChecks() },
    metrics: { gate_months: [202607, 202608, 202609], all: { n: 2800, typical_miss: 0.103 }, top8_2to4: { n: 410, typical_miss: 0.128 } },
    scoreboard: { real_matches_found: 0.98, shown_pairs_real: 0.76, right_buyer_first: 0.61 },
    sources: sources(),
    counts: {
      targets: 1500, valued: 1432, five_plus_units: 53, condo_without_unit: 12, not_found: 2, other_property_type: 1,
      trainingSales: 34000, gateSales: 2800,
    },
    expectedRows: 1500,
    ...over,
  }
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10)

// The run a job started at `at` would send: run time 10 minutes earlier, values as
// of the 1st of that month, data through the day before.
export function runAt(at: Date, over: Record<string, unknown> = {}) {
  const asOf = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1))
  return runInput({
    runAt: new Date(at.getTime() - 10 * 60_000).toISOString(),
    asOf: isoDay(asOf),
    dataThrough: isoDay(new Date(asOf.getTime() - 86_400_000)),
    ...over,
  })
}

export const facts = () => ({
  units: 2, buildingSqft: 2400, lotSqft: 2000, yearBuilt: 1899, floors: 3, zoning: 'R6B', buildingClass: 'B1',
  historicDistrict: false, lastSale: { date: '2004-06-01', price: 610000 }, dofMarketValue: { value: 1250000, fiscalYear: 2027 },
  permits7y: { count: 1, major: false }, openViolations: { dob: 0, ecb: 1, hpd: 2 }, subwayMiles: 0.31,
  leadVsCity: { units: null, buildingSqft: null },
})

// An invented nearby sale, dated before every as-of day the tests use.
export const comp = (i = 0) => ({
  address: `${200 + i} SAMPLE AVENUE`, date: '2025-11-14', price: 1700000 + i * 1000, pricePerSqft: 708, distanceMiles: 0.21,
})

export function valuedRow(contactId: string) {
  return { contactId, bbl: '3018230045', value: 1830000, low: 1537200, high: 2122800, reason: null, facts: facts(), comps: [comp(0), comp(1)] }
}

export function reasonRow(contactId: string, reason: 'five_plus_units' | 'not_found') {
  return reason === 'not_found'
    ? { contactId, bbl: null, value: null, low: null, high: null, reason, facts: null, comps: [] }
    : { contactId, bbl: '3018230046', value: null, low: null, high: null, reason, facts: facts(), comps: [] }
}

// Brief 44 test helper: an in-memory stand-in for the few Prisma calls the valuation
// handlers make. No database. Supports equality, in / notIn / not / lt filters, the
// metadata JSON-path filter, orderBy, distinct, select and $transaction.

type Row = Record<string, unknown>
type Where = Record<string, unknown>

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k]
    if (k === 'metadata' && cond && typeof cond === 'object' && 'path' in cond) {
      const c = cond as { path: string[]; equals: unknown }
      let cur: unknown = v
      for (const p of c.path) cur = cur && typeof cur === 'object' ? (cur as Row)[p] : undefined
      return cur === c.equals
    }
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; notIn?: unknown[]; not?: unknown; lt?: Date | number }
      if (c.in && !c.in.includes(v)) return false
      if (c.notIn && c.notIn.includes(v)) return false
      if ('not' in c && (c.not === null ? v == null : v === c.not)) return false
      if (c.lt != null && !(v != null && (v as number | Date) < c.lt)) return false
      return true
    }
    return v === cond
  })
}

function sorter(orderBy?: Record<string, 'asc' | 'desc'> | Record<string, 'asc' | 'desc'>[]) {
  const list = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : []
  return (a: Row, b: Row) => {
    for (const o of list) {
      const [k, dir] = Object.entries(o)[0]
      const x = a[k] instanceof Date ? (a[k] as Date).getTime() : (a[k] as number | string)
      const y = b[k] instanceof Date ? (b[k] as Date).getTime() : (b[k] as number | string)
      if (x === y) continue
      if (x == null) return 1
      if (y == null) return -1
      return (x < y ? -1 : 1) * (dir === 'asc' ? 1 : -1)
    }
    return 0
  }
}

const pick = (row: Row, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]])) : { ...row }

function table(rows: Row[], defaults: () => Row) {
  return {
    rows,
    findUnique: async (a: { where: Where; select?: Record<string, boolean> }) => {
      const r = rows.find(x => matches(x, a.where))
      return r ? pick(r, a.select) : null
    },
    findFirst: async (a: { where?: Where; orderBy?: never; select?: Record<string, boolean> }) => {
      const r = rows.filter(x => matches(x, a.where)).sort(sorter(a.orderBy))[0]
      return r ? pick(r, a.select) : null
    },
    findMany: async (a: { where?: Where; orderBy?: never; select?: Record<string, boolean>; distinct?: string[] } = {}) => {
      let out = rows.filter(x => matches(x, a.where)).sort(sorter(a.orderBy))
      if (a.distinct) {
        const seen = new Set<string>()
        out = out.filter(r => {
          const key = JSON.stringify(a.distinct!.map(k => r[k]))
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      }
      return out.map(r => pick(r, a.select))
    },
    count: async (a: { where?: Where } = {}) => rows.filter(x => matches(x, a.where)).length,
    create: async (a: { data: Row }) => {
      if (rows.some(r => r.id === a.data.id)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      const r = { ...defaults(), ...a.data }
      rows.push(r)
      return r
    },
    createMany: async (a: { data: Row[] }) => {
      for (const d of a.data) {
        if (rows.some(r => r.runId === d.runId && r.contactId === d.contactId)) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
        }
        rows.push({ ...defaults(), ...d })
      }
      return { count: a.data.length }
    },
    update: async (a: { where: Where; data: Row }) => {
      const r = rows.find(x => matches(x, a.where))
      if (!r) throw new Error('Record to update not found')
      Object.assign(r, a.data)
      return r
    },
    updateMany: async (a: { where: Where; data: Row }) => {
      const hit = rows.filter(x => matches(x, a.where))
      hit.forEach(r => Object.assign(r, a.data))
      return { count: hit.length }
    },
    deleteMany: async (a: { where: Where }) => {
      const before = rows.length
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], a.where)) rows.splice(i, 1)
      return { count: before - rows.length }
    },
  }
}

export const ORG = 'org_b44'

export function makeFakeDb(now: () => Date = () => new Date('2026-10-20T10:30:00Z')) {
  let seq = 0
  const db = {
    organization: table([{ id: ORG, slug: 'dealflow-ryan' }], () => ({})),
    mojoContact: table([], () => ({})),
    valuationRun: table([], () => ({ published: false, publishedAt: null, createdAt: now(), updatedAt: now() })),
    propertyValuation: table([], () => ({ id: `pv_${++seq}`, createdAt: now() })),
    $transaction: async (fn: unknown) => (typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db) : Promise.all(fn as unknown[])),
  }
  return db
}

export type FakeDb = ReturnType<typeof makeFakeDb>

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

export function runInput(over: Record<string, unknown> = {}) {
  return {
    runId: 'vr_20261020T100000Z_test01',
    runAt: '2026-10-20T10:00:00Z',
    asOf: '2026-10-01',
    dataThrough: '2026-09-30',
    modelVersion: 'dealflow-gbm95-v1',
    gates: { passed: true, checks: passingChecks() },
    metrics: { gateMonths: ['2026-07', '2026-08', '2026-09'], all: { n: 2800, typicalMiss: 0.103 } },
    scoreboard: { upTo: { recall: 0.98, precision: 0.76, auc: 0.96 } },
    sources: { salesThrough: '2026-09-30', plutoVersion: '26v2' },
    counts: {
      targets: 1500, valued: 1432, five_plus_units: 53, condo_without_unit: 12, not_found: 2, other_property_type: 1,
      trainingSales: 34000, gateSales: 2800,
    },
    expectedRows: 1500,
    ...over,
  }
}

export const facts = () => ({
  units: 2, buildingSqft: 2400, lotSqft: 2000, yearBuilt: 1899, floors: 3, zoning: 'R6B', buildingClass: 'B1',
  historicDistrict: false, lastSale: { date: '2004-06-01', price: 610000 }, dofMarketValue: { value: 1250000, fiscalYear: 2027 },
  permits7y: { count: 1, major: false }, openViolations: { dob: 0, ecb: 1, hpd: 2 }, taxLienNotice: false, subwayMiles: 0.31,
  leadVsCity: { units: null, buildingSqft: null },
})

export const comp = (i = 0) => ({
  address: `${200 + i} SAMPLE AVENUE`, date: '2026-05-14', price: 1700000 + i * 1000, pricePerSqft: 708, distanceMiles: 0.21,
})

export function valuedRow(contactId: string) {
  return { contactId, bbl: '3018230045', value: 1830000, low: 1537200, high: 2122800, reason: null, facts: facts(), comps: [comp(0), comp(1)] }
}

export function reasonRow(contactId: string, reason: 'five_plus_units' | 'not_found') {
  return reason === 'not_found'
    ? { contactId, bbl: null, value: null, low: null, high: null, reason, facts: null, comps: [] }
    : { contactId, bbl: '3018230046', value: null, low: null, high: null, reason, facts: facts(), comps: [] }
}

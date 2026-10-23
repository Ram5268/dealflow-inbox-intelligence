// Brief 43 PR 5: an in-memory stand-in for Prisma that EVALUATES the where
// clauses it is given, so a test can't pass by ignoring a filter. Any operator
// it doesn't know throws (it never silently matches). Install it before any
// '@/lib/...' import: lib/prisma.ts reuses globalThis.prisma when it is set, so
// no database client is ever created. Not a *.test.ts file.
//
// Supported: equality (Dates by time, null), equals/contains/startsWith/endsWith (with
// mode 'insensitive'), in, notIn, not, gt/gte/lt/lte, a JSON path + equals
// filter, has, and the AND / OR / NOT combinators. findMany (where, orderBy,
// take, select, include as empty relations), findFirst, findUnique, count,
// create and update.
// Every call is logged so a test can check what was asked of the database.
export type Row = Record<string, unknown>
export type Where = Record<string, unknown>

const FIELD_OPS = new Set(['equals', 'contains', 'startsWith', 'endsWith', 'in', 'notIn', 'not', 'gt', 'gte', 'lt', 'lte', 'path', 'has', 'mode'])

const norm = (v: unknown, insensitive: boolean) => (insensitive && typeof v === 'string' ? v.toLowerCase() : v)
const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b)

function fieldMatches(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null || value === undefined
  if (typeof cond !== 'object' || cond instanceof Date || Array.isArray(cond)) return same(value, cond)
  const c = cond as Record<string, unknown>
  for (const op of Object.keys(c)) if (!FIELD_OPS.has(op)) throw new Error(`pr5FakePrisma: unsupported operator "${op}"`)
  const ins = c.mode === 'insensitive'
  let v = value
  if ('path' in c) {
    for (const k of c.path as string[]) v = v && typeof v === 'object' ? (v as Row)[k] : undefined
    if (!('equals' in c)) throw new Error('pr5FakePrisma: a JSON path filter needs equals')
  }
  if ('equals' in c && !same(norm(v, ins), norm(c.equals, ins))) return false
  if ('contains' in c && !(typeof v === 'string' && (norm(v, ins) as string).includes(norm(c.contains, ins) as string))) return false
  if ('startsWith' in c && !(typeof v === 'string' && (norm(v, ins) as string).startsWith(norm(c.startsWith, ins) as string))) return false
  if ('endsWith' in c && !(typeof v === 'string' && (norm(v, ins) as string).endsWith(norm(c.endsWith, ins) as string))) return false
  if ('in' in c && !(c.in as unknown[]).some(x => same(norm(v, ins), norm(x, ins)))) return false
  if ('notIn' in c && (c.notIn as unknown[]).some(x => same(v, x))) return false
  if ('not' in c && fieldMatches(v, c.not)) return false
  if ('gt' in c && !((v as number) > (c.gt as number))) return false
  if ('gte' in c && !((v as number) >= (c.gte as number))) return false
  if ('lt' in c && !((v as number) < (c.lt as number))) return false
  if ('lte' in c && !((v as number) <= (c.lte as number))) return false
  if ('has' in c && !(Array.isArray(v) && v.includes(c.has))) return false
  return true
}

export function matchesWhere(row: Row, where: Where | undefined): boolean {
  for (const [k, cond] of Object.entries(where ?? {})) {
    if (cond === undefined) continue
    if (k === 'AND') {
      const parts = Array.isArray(cond) ? cond : [cond]
      if (!parts.every(w => matchesWhere(row, w as Where))) return false
    } else if (k === 'OR') {
      if (!(cond as Where[]).some(w => matchesWhere(row, w))) return false
    } else if (k === 'NOT') {
      const parts = Array.isArray(cond) ? cond : [cond]
      if (parts.some(w => matchesWhere(row, w as Where))) return false
    } else if (!fieldMatches(row[k], cond)) return false
  }
  return true
}

type Order = Record<string, 'asc' | 'desc'>
function sortRows(rows: Row[], orderBy: Order | Order[] | undefined): Row[] {
  if (!orderBy) return rows
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap(o => Object.entries(o))
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = a[k] instanceof Date ? (a[k] as Date).getTime() : a[k]
      const y = b[k] instanceof Date ? (b[k] as Date).getTime() : b[k]
      if (x === y) continue
      if (x == null) return 1
      if (y == null) return -1
      const r = (x as number | string) > (y as number | string) ? 1 : -1
      return dir === 'desc' ? -r : r
    }
    return 0
  })
}

const pick = (row: Row, select?: Record<string, unknown>, include?: Record<string, unknown>): Row => {
  const out = select ? Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]])) : { ...row }
  // A relation in `include` comes back as the row's own array, or empty.
  for (const k of Object.keys(include ?? {})) out[k] = row[k] ?? []
  return out
}

export interface Call { model: string; op: string; args: Record<string, unknown> | undefined; returned: number }

export function makeFakePrisma(tables: Record<string, Row[]>) {
  const calls: Call[] = []
  let seq = 0
  const model = (name: string) => {
    const rows = () => (tables[name] ??= [])
    const log = (op: string, args: Record<string, unknown> | undefined, returned: number) => calls.push({ model: name, op, args, returned })
    return {
      findMany: async (args: Record<string, unknown> = {}) => {
        let out = sortRows(rows().filter(r => matchesWhere(r, args.where as Where)), args.orderBy as Order[])
        if (typeof args.skip === 'number') out = out.slice(args.skip)
        if (typeof args.take === 'number') out = out.slice(0, args.take)
        log('findMany', args, out.length)
        return out.map(r => pick(r, args.select as Record<string, unknown>, args.include as Record<string, unknown>))
      },
      findFirst: async (args: Record<string, unknown> = {}) => {
        const out = sortRows(rows().filter(r => matchesWhere(r, args.where as Where)), args.orderBy as Order[])
        log('findFirst', args, out.length ? 1 : 0)
        return out[0] ? pick(out[0], args.select as Record<string, unknown>) : null
      },
      findUnique: async (args: Record<string, unknown> = {}) => {
        const r = rows().find(x => matchesWhere(x, args.where as Where))
        log('findUnique', args, r ? 1 : 0)
        return r ? pick(r, args.select as Record<string, unknown>) : null
      },
      count: async (args: Record<string, unknown> = {}) => {
        const n = rows().filter(r => matchesWhere(r, args.where as Where)).length
        log('count', args, n)
        return n
      },
      create: async (args: { data: Row; select?: Record<string, unknown> }) => {
        const row: Row = { id: `fake_${name}_${++seq}`, createdAt: new Date(Date.UTC(2026, 9, 19, 12, 0, seq)), ...args.data }
        rows().push(row)
        log('create', args as unknown as Record<string, unknown>, 1)
        return pick(row, args.select)
      },
      update: async (args: { where: Where; data: Row }) => {
        const r = rows().find(x => matchesWhere(x, args.where))
        if (r) Object.assign(r, args.data)
        log('update', args as unknown as Record<string, unknown>, r ? 1 : 0)
        return r ?? { ...args.data }
      },
    }
  }
  const prisma = new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string | symbol) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined
      if (prop === '$disconnect') return async () => {}
      return model(prop)
    },
  })
  return { prisma, calls, tables }
}

// Fictional CRM contacts (Brief 43 HELPER_RULES rule 7): "Probe" names, Example
// streets and the 555-01xx range only.
export const ORG = 'org_pr5'
export const ORG_ROW = { id: ORG, slug: 'dealflow-ryan' }
const T0 = Date.UTC(2026, 9, 1)

let n = 0
export function contact(over: Row = {}): Row {
  const i = ++n
  return {
    id: `mc_${String(i).padStart(4, '0')}`, mojoId: `m${i}`, organizationId: ORG,
    fullName: `Probe Seller ${String(i).padStart(4, '0')}`, coOwnerFullName: null,
    phone: `718555${String(100 + (i % 100)).padStart(4, '0')}`, additionalPhones: [], phoneDncFlags: [],
    address: `${1000 + i} Example Ave`, city: 'Brooklyn', neighborhood: 'Bedford-Stuyvesant',
    status: 'No Answer', notes: `Probe note ${i}`, intent: 'SELLER', isTestData: false,
    metadata: { source: 'crm', crmLeadId: `lead_${i}`, lastCallResult: 'No Answer' },
    budgetMin: null, budgetMax: null, bedsMin: null, bedsMax: null, initialNeighborhood: null,
    priorListingStatus: null, priorListingPrice: null,
    updatedAt: new Date(T0 + i * 60_000), syncedAt: new Date(T0 + i * 60_000),
    ...over,
  }
}

// 650 real-looking CRM sellers, half in Bed-Stuy and half in Crown Heights, with
// updatedAt rising by index: index 0 is the OLDEST (outside the newest 500).
export function sixHundredFifty(): Row[] {
  n = 0
  return Array.from({ length: 650 }, (_, i) => contact({ neighborhood: i % 2 ? 'Crown Heights' : 'Bedford-Stuyvesant' }))
}

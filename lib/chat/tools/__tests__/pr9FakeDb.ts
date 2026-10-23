// Brief 43 PR 9 test helper: an in-memory stand-in for the Prisma calls that
// search_parties and the Buyer Match report make. It understands the `where`
// shapes those calls use (equality, null, in / notIn / not, contains and
// startsWith with mode 'insensitive', OR / AND / NOT, a JSON path/equals),
// plus orderBy, take, select and include. Every call is logged so a test can
// see the query (e.g. the name filter reached the database, not just memory).
// No database, no network. Not a *.test.ts file. Everyone in it is fictional.
export type Row = Record<string, unknown>
type Where = Record<string, unknown>
type Args = { where?: Where; orderBy?: unknown; take?: number; select?: Row; include?: Row; data?: Row }

function cond(value: unknown, c: unknown): boolean {
  if (c === null) return value == null
  if (c instanceof Date) return value instanceof Date && value.getTime() === c.getTime()
  if (typeof c !== 'object' || Array.isArray(c)) return value === c
  const o = c as Record<string, unknown>
  if ('path' in o) {
    let v: unknown = value
    for (const k of o.path as string[]) v = v && typeof v === 'object' ? (v as Row)[k] : undefined
    return 'equals' in o ? v === o.equals : true
  }
  const ins = o.mode === 'insensitive'
  const s = (x: unknown) => (ins ? String(x).toLowerCase() : String(x))
  for (const [op, v] of Object.entries(o)) {
    if (op === 'mode') continue
    if (op === 'equals' && value !== v) return false
    if (op === 'in' && !(v as unknown[]).includes(value)) return false
    if (op === 'notIn' && (v as unknown[]).includes(value)) return false
    if (op === 'not' && (v === null ? value == null : cond(value, v))) return false
    if (op === 'contains' && (typeof value !== 'string' || !s(value).includes(s(v)))) return false
    if (op === 'startsWith' && (typeof value !== 'string' || !s(value).startsWith(s(v)))) return false
    if (op === 'gte' && !((value as number) >= (v as number))) return false
    if (op === 'lte' && !((value as number) <= (v as number))) return false
  }
  return true
}

export function fits(row: Row, where: Where = {}): boolean {
  for (const [k, c] of Object.entries(where)) {
    if (c === undefined) continue
    if (k === 'OR') { if (!(c as Where[]).some(w => fits(row, w))) return false; continue }
    if (k === 'AND') { if (!(Array.isArray(c) ? c : [c]).every(w => fits(row, w as Where))) return false; continue }
    if (k === 'NOT') { if (fits(row, c as Where)) return false; continue }
    if (!cond(row[k], c)) return false
  }
  return true
}

function sorted(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap(o => Object.entries(o as Row)) as Array<[string, string]>
  const val = (x: unknown) => (x instanceof Date ? x.getTime() : x) as number
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const av = val(a[k]), bv = val(b[k])
      if (av === bv) continue
      return (av > bv ? 1 : -1) * (dir === 'desc' ? -1 : 1)
    }
    return 0
  })
}

function shaped(row: Row, select?: Row, include?: Row): Row {
  const out: Row = select
    ? Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k] ?? null]))
    : { ...row }
  for (const k of Object.keys(include ?? {})) out[k] = row[k] ?? null
  return out
}

export function pr9FakeDb(tables: Record<string, Row[]> = {}) {
  const data: Record<string, Row[]> = { ...tables }
  const calls: Array<{ model: string; op: string; args: Args }> = []
  let seq = 0
  const rows = (m: string) => (data[m] ??= [])
  const model = (m: string) => ({
    findMany: async (args: Args = {}) => {
      calls.push({ model: m, op: 'findMany', args })
      const hit = sorted(rows(m).filter(r => fits(r, args.where)), args.orderBy)
      return (args.take != null ? hit.slice(0, args.take) : hit).map(r => shaped(r, args.select, args.include))
    },
    findFirst: async (args: Args = {}) => {
      calls.push({ model: m, op: 'findFirst', args })
      const r = sorted(rows(m).filter(x => fits(x, args.where)), args.orderBy)[0]
      return r ? shaped(r, args.select, args.include) : null
    },
    findUnique: async (args: Args = {}) => {
      calls.push({ model: m, op: 'findUnique', args })
      const r = rows(m).find(x => fits(x, args.where))
      return r ? shaped(r, args.select, args.include) : null
    },
    count: async (args: Args = {}) => {
      calls.push({ model: m, op: 'count', args })
      return rows(m).filter(r => fits(r, args.where)).length
    },
    create: async (args: Args) => {
      calls.push({ model: m, op: 'create', args })
      const row = { id: `${m}_${++seq}`, createdAt: new Date(Date.UTC(2026, 9, 19, 12, 0, seq)), ...args.data }
      rows(m).push(row)
      return args.select ? shaped(row, args.select) : row
    },
    update: async (args: Args) => {
      calls.push({ model: m, op: 'update', args })
      const r = rows(m).find(x => fits(x, args.where))
      if (r) Object.assign(r, args.data)
      return r ?? { ...args.data }
    },
    updateMany: async (args: Args) => {
      calls.push({ model: m, op: 'updateMany', args })
      return { count: 0 }
    },
  })
  const prisma = new Proxy({}, { get: (_t, m) => (typeof m === 'string' && !m.startsWith('$') ? model(m) : undefined) })
  return { prisma, data, calls }
}

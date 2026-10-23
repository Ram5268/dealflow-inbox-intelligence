// Brief 43 PR 7: an in-memory stand-in for Prisma that EVALUATES the where
// clauses the chat search tools build, with SQL's null rules (a comparison
// against NULL is unknown, so `{ not: x }` drops null rows and NOT(unknown) stays
// unknown), case-insensitive `contains`, AND/OR/NOT and scalar-list filters. A
// test can't pass by a tool ignoring a filter, and a filter the real database
// would reject fails here too: it throws on an unknown column or operator, on a
// fractional number for an Int column, and on a string operator for a number.
// Column names and types come from prisma/schema.prisma, so a misspelled column
// fails. No database, no network.
//
// Import it FIRST in a test file: lib/prisma reuses globalThis.prisma when set.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Row = Record<string, unknown>
type Tri = boolean | null // SQL three-valued logic: null = unknown
interface FieldInfo { type: string; isList: boolean }

// model delegate name ("extractedOpportunity") -> column -> type. Relations and
// Unsupported(...) columns are left out.
const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'BigInt', 'Decimal'])
const MODELS = new Map<string, Map<string, FieldInfo>>()
{
  const schema = readFileSync(join(__dirname, '..', '..', '..', '..', 'prisma', 'schema.prisma'), 'utf8')
  const enums = new Set([...schema.matchAll(/^enum\s+(\w+)\s*\{/gm)].map(m => m[1]))
  for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const fields = new Map<string, FieldInfo>()
    for (const line of m[2].split('\n')) {
      const f = line.trim().match(/^(\w+)\s+(\w+)(\[\])?/)
      if (!f) continue
      const [, name, type, list] = f
      if (SCALARS.has(type)) fields.set(name, { type, isList: list != null })
      else if (enums.has(type)) fields.set(name, { type: 'Enum', isList: list != null })
    }
    MODELS.set(m[1].charAt(0).toLowerCase() + m[1].slice(1), fields)
  }
}

const and3 = (xs: Tri[]): Tri => (xs.some(x => x === false) ? false : xs.some(x => x === null) ? null : true)
const or3 = (xs: Tri[]): Tri => (xs.some(x => x === true) ? true : xs.some(x => x === null) ? null : false)
const not3 = (x: Tri): Tri => (x === null ? null : !x)

function scalarOf(v: unknown): unknown {
  return v instanceof Date ? v.getTime() : v
}

function checkOperand(model: string, field: string, info: FieldInfo, op: string, v: unknown): void {
  if (v === null || v === undefined) return
  const values = Array.isArray(v) ? v : [v]
  for (const x of values) {
    if (info.type === 'Int' && (typeof x !== 'number' || !Number.isInteger(x))) throw new Error(`fake db: ${model}.${field} is Int; ${op} got ${JSON.stringify(x)}`)
    if (info.type === 'Float' && typeof x !== 'number') throw new Error(`fake db: ${model}.${field} is Float; ${op} got ${JSON.stringify(x)}`)
    if ((info.type === 'String' || info.type === 'Enum') && typeof x !== 'string') throw new Error(`fake db: ${model}.${field} is ${info.type}; ${op} got ${JSON.stringify(x)}`)
    if (info.type === 'Boolean' && typeof x !== 'boolean') throw new Error(`fake db: ${model}.${field} is Boolean; ${op} got ${JSON.stringify(x)}`)
  }
}

function fieldCond(model: string, field: string, info: FieldInfo, rowV: unknown, cond: unknown): Tri {
  if (info.isList) return listCond(model, field, rowV, cond)
  if (cond === null) return rowV === null || rowV === undefined
  const row = rowV === undefined ? null : rowV
  if (typeof cond !== 'object' || cond instanceof Date) {
    checkOperand(model, field, info, 'equals', cond)
    return row === null ? null : scalarOf(row) === scalarOf(cond)
  }
  const c = cond as Record<string, unknown>
  const mode = c.mode
  if (mode !== undefined && mode !== 'insensitive' && mode !== 'default') throw new Error(`fake db: bad mode ${String(mode)}`)
  const ins = mode === 'insensitive'
  if (ins && info.type !== 'String') throw new Error(`fake db: mode on non-string ${model}.${field}`)
  const norm = (x: unknown) => (ins && typeof x === 'string' ? x.toLowerCase() : scalarOf(x))
  const parts: Tri[] = []
  for (const [op, v] of Object.entries(c)) {
    if (op === 'mode' || v === undefined) continue
    switch (op) {
      case 'equals':
        checkOperand(model, field, info, op, v)
        parts.push(v === null ? row === null : row === null ? null : norm(row) === norm(v))
        break
      case 'not':
        if (v === null) { parts.push(row !== null); break }
        if (typeof v === 'object' && !(v instanceof Date)) { parts.push(not3(fieldCond(model, field, info, rowV, v))); break }
        checkOperand(model, field, info, op, v)
        parts.push(row === null ? null : norm(row) !== norm(v))
        break
      case 'in':
      case 'notIn': {
        if (!Array.isArray(v)) throw new Error(`fake db: ${op} needs an array`)
        checkOperand(model, field, info, op, v)
        const hit = row === null ? null : v.map(norm).includes(norm(row))
        parts.push(hit === null ? null : op === 'in' ? hit : !hit)
        break
      }
      case 'lt': case 'lte': case 'gt': case 'gte': {
        checkOperand(model, field, info, op, v)
        if (row === null) { parts.push(null); break }
        const a = norm(row) as number | string, b = norm(v) as number | string
        parts.push(op === 'lt' ? a < b : op === 'lte' ? a <= b : op === 'gt' ? a > b : a >= b)
        break
      }
      case 'contains': case 'startsWith': case 'endsWith': {
        if (info.type !== 'String') throw new Error(`fake db: ${op} on non-string ${model}.${field}`)
        checkOperand(model, field, info, op, v)
        if (row === null) { parts.push(null); break }
        const a = String(norm(row)), b = String(norm(v))
        parts.push(op === 'contains' ? a.includes(b) : op === 'startsWith' ? a.startsWith(b) : a.endsWith(b))
        break
      }
      default:
        throw new Error(`fake db: unsupported operator ${op} on ${model}.${field}`)
    }
  }
  return and3(parts)
}

function listCond(model: string, field: string, rowV: unknown, cond: unknown): Tri {
  if (cond === null || typeof cond !== 'object') throw new Error(`fake db: list ${model}.${field} needs a list filter`)
  if (rowV === null || rowV === undefined) return null
  const arr = rowV as unknown[]
  const parts: Tri[] = []
  for (const [op, v] of Object.entries(cond as Record<string, unknown>)) {
    if (v === undefined) continue
    if (op === 'has') parts.push(arr.includes(v))
    else if (op === 'hasSome') parts.push((v as unknown[]).some(x => arr.includes(x)))
    else if (op === 'hasEvery') parts.push((v as unknown[]).every(x => arr.includes(x)))
    else if (op === 'isEmpty') parts.push((arr.length === 0) === v)
    else if (op === 'equals') parts.push(JSON.stringify(arr) === JSON.stringify(v))
    else throw new Error(`fake db: unsupported list operator ${op} on ${model}.${field}`)
  }
  return and3(parts)
}

export function evalWhere(model: string, row: Row, where: unknown): Tri {
  if (where === undefined) return true
  if (where === null || typeof where !== 'object' || Array.isArray(where)) throw new Error('fake db: a where clause must be an object')
  const fields = MODELS.get(model)
  if (!fields) throw new Error(`fake db: unknown model ${model}`)
  const parts: Tri[] = []
  for (const [k, v] of Object.entries(where as Record<string, unknown>)) {
    if (v === undefined) continue
    if (k === 'AND') parts.push(and3((Array.isArray(v) ? v : [v]).map(w => evalWhere(model, row, w))))
    else if (k === 'OR') {
      if (!Array.isArray(v)) throw new Error('fake db: OR needs an array')
      parts.push(or3(v.map(w => evalWhere(model, row, w))))
    } else if (k === 'NOT') parts.push(and3((Array.isArray(v) ? v : [v]).map(w => not3(evalWhere(model, row, w)))))
    else {
      const info = fields.get(k)
      if (!info) throw new Error(`fake db: unknown column ${model}.${k}`)
      parts.push(fieldCond(model, k, info, row[k], v))
    }
  }
  return and3(parts)
}

type Order = Record<string, 'asc' | 'desc'>
function sortRows(model: string, rows: Row[], orderBy: Order | Order[] | undefined): Row[] {
  if (!orderBy) return rows
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap(o => Object.entries(o))
  for (const [k, dir] of keys) {
    if (!MODELS.get(model)?.has(k)) throw new Error(`fake db: unknown orderBy column ${model}.${k}`)
    if (dir !== 'asc' && dir !== 'desc') throw new Error(`fake db: orderBy ${k} must be asc or desc`)
  }
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = scalarOf(a[k] ?? null), y = scalarOf(b[k] ?? null)
      if (x === y) continue
      // Postgres: NULLS LAST for asc, NULLS FIRST for desc.
      if (x === null) return dir === 'asc' ? 1 : -1
      if (y === null) return dir === 'asc' ? -1 : 1
      const r = (x as number) > (y as number) ? 1 : -1
      return dir === 'desc' ? -r : r
    }
    return 0
  })
}

function project(model: string, row: Row, select: Record<string, unknown> | undefined): Row {
  if (!select) return { ...row }
  const out: Row = {}
  for (const [k, on] of Object.entries(select)) {
    if (!on) continue
    const info = MODELS.get(model)?.get(k)
    if (!info) throw new Error(`fake db: unknown select column ${model}.${k}`)
    out[k] = row[k] ?? (info.isList ? [] : null)
  }
  return out
}

export interface FakeCall { model: string; op: string; args: Record<string, unknown>; returned: number }

export const fakeDb = {
  tables: {} as Record<string, Row[]>,
  calls: [] as FakeCall[],
  reset(tables: Record<string, Row[]>) {
    this.tables = tables
    this.calls = []
  },
}

const ALLOWED_ARGS = new Set(['where', 'orderBy', 'take', 'select'])
function delegate(model: string) {
  const rowsFor = (args: Record<string, unknown> = {}) => {
    for (const k of Object.keys(args)) if (!ALLOWED_ARGS.has(k)) throw new Error(`fake db: unsupported argument ${k}`)
    const all = fakeDb.tables[model] ?? []
    return sortRows(model, all.filter(r => evalWhere(model, r, args.where) === true), args.orderBy as Order | Order[] | undefined)
  }
  return {
    findMany: async (args: Record<string, unknown> = {}) => {
      let rows = rowsFor(args)
      if (typeof args.take === 'number') rows = rows.slice(0, args.take)
      fakeDb.calls.push({ model, op: 'findMany', args, returned: rows.length })
      return rows.map(r => project(model, r, args.select as Record<string, unknown> | undefined))
    },
    findFirst: async (args: Record<string, unknown> = {}) => {
      const rows = rowsFor(args)
      fakeDb.calls.push({ model, op: 'findFirst', args, returned: rows.length ? 1 : 0 })
      return rows[0] ? project(model, rows[0], args.select as Record<string, unknown> | undefined) : null
    },
    findUnique: async (args: Record<string, unknown> = {}) => {
      const rows = rowsFor(args)
      fakeDb.calls.push({ model, op: 'findUnique', args, returned: rows.length ? 1 : 0 })
      return rows[0] ? project(model, rows[0], args.select as Record<string, unknown> | undefined) : null
    },
    count: async (args: Record<string, unknown> = {}) => rowsFor(args).length,
  }
}

;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy({}, {
  get(_t, prop) {
    if (typeof prop !== 'string' || prop === 'then') return undefined
    if (!MODELS.has(prop)) throw new Error(`fake db: unknown model ${prop}`)
    return delegate(prop)
  },
})

// The newest findMany on a model: what the tool asked the database for.
export function lastQuery(model: string): FakeCall {
  const call = [...fakeDb.calls].reverse().find(c => c.model === model && c.op === 'findMany')
  if (!call) throw new Error(`fake db: no findMany on ${model}`)
  return call
}

// Brief 45 (PR E): an in-memory stand-in for the Prisma calls the nightly call
// list and the import-scoring path make, so their tests run with no database.
// It understands only the `where` shapes those calls use: equality, `in`,
// `{ not: null }`, `OR`, and a JSON `path`/`equals` filter. Raw SQL goes to the
// test's own `onRaw` handler. Every call is logged with the transaction it ran
// in, and every model the code touches is recorded, so a test can prove a model
// (CallQueueEntry) was never used. Not a *.test.ts file.
export type Row = Record<string, unknown>

export interface Call {
  model: string | null // null for raw SQL
  op: string
  args?: unknown
  sql?: string
  params?: unknown[]
  tx: number | null // the $transaction it ran in, if any
}

export type RawHandler = (sql: string, params: unknown[], kind: 'query' | 'execute', data: Record<ModelName, Row[]>) => unknown

const MODELS = ['organization', 'mojoContact', 'match', 'matchDismissal', 'extractedOpportunity', 'auditLog', 'callQueueEntry'] as const
export type ModelName = (typeof MODELS)[number]

function get(row: Row, path: string[]): unknown {
  let v: unknown = row
  for (const p of path) v = v && typeof v === 'object' ? (v as Row)[p] : undefined
  return v
}

export function matchesWhere(row: Row, where: Row | undefined): boolean {
  for (const [k, cond] of Object.entries(where ?? {})) {
    if (k === 'OR') {
      if (!(cond as Row[]).some(w => matchesWhere(row, w))) return false
      continue
    }
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      const c = cond as Row
      const v = 'path' in c ? get((row[k] ?? {}) as Row, c.path as string[]) : row[k]
      if ('equals' in c && v !== c.equals) return false
      if ('in' in c && !(c.in as unknown[]).includes(v)) return false
      if ('not' in c && (c.not === null ? v == null : v === c.not)) return false
      continue
    }
    if (row[k] !== cond) return false
  }
  return true
}

const pick = (row: Row, select?: Row): Row =>
  select ? Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]])) : { ...row }

export function memoryDb(tables: Partial<Record<ModelName, Row[]>> = {}, onRaw: RawHandler = () => []) {
  const data = Object.fromEntries(MODELS.map(m => [m, [...(tables[m] ?? [])]])) as Record<ModelName, Row[]>
  const calls: Call[] = []
  const touched = new Set<string>()
  const txs: { id: number; outcome: 'commit' | 'rollback' | 'open' }[] = []
  let currentTx: number | null = null
  let nextId = 1

  const model = (name: ModelName) => ({
    findMany: async (args: { where?: Row; select?: Row } = {}) => {
      calls.push({ model: name, op: 'findMany', args, tx: currentTx })
      return data[name].filter(r => matchesWhere(r, args.where)).map(r => pick(r, args.select))
    },
    findUnique: async (args: { where: Row; select?: Row }) => {
      calls.push({ model: name, op: 'findUnique', args, tx: currentTx })
      const r = data[name].find(x => matchesWhere(x, args.where))
      return r ? pick(r, args.select) : null
    },
    findUniqueOrThrow: async (args: { where: Row; select?: Row }) => {
      calls.push({ model: name, op: 'findUniqueOrThrow', args, tx: currentTx })
      const r = data[name].find(x => matchesWhere(x, args.where))
      if (!r) throw new Error(`No ${name} found`)
      return pick(r, args.select)
    },
    create: (args: { data: Row }) => {
      calls.push({ model: name, op: 'create', args, tx: currentTx })
      const row = { id: `${name}_${nextId++}`, ...args.data }
      data[name].push(row)
      return Promise.resolve(row)
    },
    createMany: (args: { data: Row[] }) => {
      calls.push({ model: name, op: 'createMany', args, tx: currentTx })
      data[name].push(...args.data)
      return Promise.resolve({ count: args.data.length })
    },
    deleteMany: (args: { where?: Row } = {}) => {
      calls.push({ model: name, op: 'deleteMany', args, tx: currentTx })
      const before = data[name].length
      data[name] = data[name].filter(r => !matchesWhere(r, args.where))
      return Promise.resolve({ count: before - data[name].length })
    },
  })

  const raw = (kind: 'query' | 'execute') => async (sql: string, ...params: unknown[]) => {
    calls.push({ model: null, op: kind === 'query' ? '$queryRawUnsafe' : '$executeRawUnsafe', sql, params, tx: currentTx })
    return onRaw(sql, params, kind, data)
  }

  const base: Row = {
    ...Object.fromEntries(MODELS.map(m => [m, model(m)])),
    $queryRawUnsafe: raw('query'),
    $executeRawUnsafe: raw('execute'),
    $transaction: async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg)
      const id = txs.length + 1
      txs.push({ id, outcome: 'open' })
      currentTx = id
      try {
        const result = await (arg as (tx: unknown) => Promise<unknown>)(db)
        txs[id - 1].outcome = 'commit'
        return result
      } catch (e) {
        txs[id - 1].outcome = 'rollback'
        throw e
      } finally {
        currentTx = null
      }
    },
  }
  // Records every property the code reads, so "never touched" is provable.
  const db = new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'string') touched.add(prop)
      return target[prop as string]
    },
  })

  return {
    db,
    data,
    calls,
    touched,
    txs,
    // Writes: model creates/deletes, every $executeRawUnsafe, and any raw query
    // whose text holds a writing keyword (an INSERT … RETURNING, say).
    writes: () => calls.filter(c => ['create', 'createMany', 'deleteMany', '$executeRawUnsafe'].includes(c.op) ||
      (c.op === '$queryRawUnsafe' && /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/.test(c.sql ?? ''))),
  }
}

// Brief 48 (PR 15): a small in-memory stand-in for the Prisma calls that replace an
// email's listings (extractEmailV2, the buried-lead pass, the reextract and
// reclassify maintenance routes) and the StreetEasy date sweep. Not a *.test.ts file.
// It understands only the `where` shapes those calls use. Both $transaction forms
// work: a list of calls runs in order (Prisma's calls only run when awaited or
// handed to $transaction), a function gets this same client. Every call is logged
// with whether it ran inside a transaction; a failed transaction puts the data back.
export type Row = Record<string, unknown>
export type Call = { model: string; op: string; inTx: boolean; args: Row }

function fits(row: Row, where: Row | undefined): boolean {
  return Object.entries(where ?? {}).every(([key, want]) => {
    if (key === 'OR') return (want as Row[]).some(w => fits(row, w))
    if (key === 'AND') return (want as Row[]).every(w => fits(row, w))
    const got = row[key]
    if (want === null) return got === null || got === undefined
    if (typeof want !== 'object' || want instanceof Date) return got instanceof Date && want instanceof Date ? got.getTime() === want.getTime() : got === want
    const ops = want as Row
    const known = ['in', 'notIn', 'not', 'lt', 'gte', 'contains', 'startsWith', 'mode']
    // A relation filter, e.g. rawEmail: { graphMessageId: { not: … } }: the related row is stored on the row.
    if (!Object.keys(ops).some(k => known.includes(k))) return fits((got ?? {}) as Row, ops)
    return Object.entries(ops).every(([op, x]) => {
      switch (op) {
        case 'in': return (x as unknown[]).includes(got)
        case 'notIn': return !(x as unknown[]).includes(got)
        case 'not':
          if (x === null) return got !== null && got !== undefined
          if (typeof x === 'object' && x !== null && 'contains' in (x as Row)) return !(typeof got === 'string' && got.includes(String((x as Row).contains)))
          return got !== x
        case 'lt': return got instanceof Date ? got.getTime() < (x as Date).getTime() : got !== null && got !== undefined && (got as string) < (x as string)
        case 'gte': return got instanceof Date && got.getTime() >= (x as Date).getTime()
        case 'contains': return typeof got === 'string' && ((ops.mode === 'insensitive') ? got.toLowerCase().includes(String(x).toLowerCase()) : got.includes(String(x)))
        case 'startsWith': return typeof got === 'string' && got.startsWith(String(x))
        case 'mode': return true
        default: throw new Error(`listingDb: unknown filter ${op}`)
      }
    })
  })
}

const pick = (row: Row, select?: Row): Row =>
  select ? Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]])) : { ...row }

export function listingDb(seed: Record<string, Row[]>) {
  let data: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([m, rows]) => [m, rows.map(r => ({ ...r }))]))
  const calls: Call[] = []
  let inTx = false
  let nextId = 1
  const table = (m: string) => (data[m] ??= [])

  // A Prisma-like call: it runs once, when awaited or when $transaction runs it.
  function call<T>(model: string, op: string, args: Row, run: () => T) {
    let p: Promise<T> | null = null
    const go = () => (p ??= Promise.resolve().then(() => {
      calls.push({ model, op, inTx, args })
      return run()
    }))
    return { then: (a?: (v: T) => unknown, b?: (e: unknown) => unknown) => go().then(a, b), catch: (b: (e: unknown) => unknown) => go().catch(b), go }
  }

  const model = (m: string) => ({
    findMany: (args: Row = {}) => call(m, 'findMany', args, () => {
      let rows = table(m).filter(r => fits(r, args.where as Row))
      if (typeof args.take === 'number') rows = rows.slice(0, args.take)
      return rows.map(r => pick(r, args.select as Row))
    }),
    findUnique: (args: Row) => call(m, 'findUnique', args, () => {
      const r = table(m).find(x => fits(x, args.where as Row))
      return r ? pick(r, args.select as Row) : null
    }),
    findFirst: (args: Row = {}) => call(m, 'findFirst', args, () => {
      const r = table(m).find(x => fits(x, args.where as Row))
      return r ? pick(r, args.select as Row) : null
    }),
    count: (args: Row = {}) => call(m, 'count', args, () => table(m).filter(r => fits(r, args.where as Row)).length),
    create: (args: Row) => call(m, 'create', args, () => {
      const row = { id: `${m}-new-${nextId++}`, createdAt: new Date(), ...(args.data as Row) }
      table(m).push(row)
      return { ...row }
    }),
    update: (args: Row) => call(m, 'update', args, () => {
      const r = table(m).find(x => fits(x, args.where as Row))
      if (!r) throw new Error(`listingDb: no ${m} row to update`)
      Object.assign(r, args.data as Row)
      return { ...r }
    }),
    deleteMany: (args: Row = {}) => call(m, 'deleteMany', args, () => {
      const before = table(m).length
      data[m] = table(m).filter(r => !fits(r, args.where as Row))
      return { count: before - data[m].length }
    }),
    delete: (args: Row) => call(m, 'delete', args, () => {
      const i = table(m).findIndex(r => fits(r, args.where as Row))
      if (i < 0) throw new Error(`listingDb: no ${m} row to delete`)
      const [r] = table(m).splice(i, 1)
      return r
    }),
  })

  const models = new Map<string, ReturnType<typeof model>>()
  const client: Record<string, unknown> = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'then') return undefined
      if (prop === '$transaction') return $transaction
      if (typeof prop !== 'string') return undefined
      if (!models.has(prop)) models.set(prop, model(prop))
      return models.get(prop)
    },
  })

  async function $transaction(arg: unknown): Promise<unknown> {
    const saved = Object.fromEntries(Object.entries(data).map(([m, rows]) => [m, rows.map(r => ({ ...r }))]))
    inTx = true
    try {
      if (typeof arg === 'function') return await (arg as (tx: unknown) => Promise<unknown>)(client)
      const out: unknown[] = []
      for (const c of arg as Array<{ go: () => Promise<unknown> }>) out.push(await c.go())
      return out
    } catch (e) {
      data = saved
      throw e
    } finally {
      inTx = false
    }
  }

  return { client, calls, rows: (m: string) => table(m) }
}

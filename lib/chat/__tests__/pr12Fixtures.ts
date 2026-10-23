// Brief 43 PR 12: our published values for the D9 tests, on top of PR 6's fake
// Prisma (pr6Fixtures.ts / pr5FakePrisma.ts, which evaluate every where clause).
// PR 5's fake can't read the relation filter `run: { published: true }`, so
// propertyValuation.findMany is evaluated here, each row joined to its
// ValuationRun, and it throws on any filter or select it doesn't know (it never
// silently matches). Fictional people only (Brief 43 HELPER_RULES rule 7).
// Not a *.test.ts file.
import { makeFakePrisma as makePr6FakePrisma, type Row } from './pr6Fixtures'
import { ORG } from './pr5FakePrisma'

export { contact, match, isoBuyer, ORG, ORG_ROW, type Row } from './pr6Fixtures'

const DAY_MS = 86_400_000
export const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS)
const OCT_1 = new Date(Date.UTC(2026, 9, 1))

export function makeFakePrisma(tables: Record<string, Row[]>) {
  const fake = makePr6FakePrisma(tables)
  const findMany = async (args: { where?: Row; select?: Record<string, unknown> } = {}) => {
    const where = args.where ?? {}
    for (const k of Object.keys(where)) if (!['organizationId', 'contactId', 'run'].includes(k)) throw new Error(`pr12Fixtures: unsupported filter "${k}"`)
    const runWhere = (where.run ?? {}) as Row
    for (const k of Object.keys(runWhere)) if (k !== 'published') throw new Error(`pr12Fixtures: unsupported run filter "${k}"`)
    const runs = new Map((fake.tables.valuationRun ?? []).map(r => [r.id, r]))
    const out = (fake.tables.propertyValuation ?? []).filter(v => {
      const run = runs.get(v.runId)
      return (!('organizationId' in where) || v.organizationId === where.organizationId)
        && (!('contactId' in where) || v.contactId === where.contactId)
        && (!('published' in runWhere) || (run != null && run.published === runWhere.published))
    })
    fake.calls.push({ model: 'propertyValuation', op: 'findMany', args: args as Record<string, unknown>, returned: out.length })
    const select = args.select
    if (!select) throw new Error('pr12Fixtures: a select is expected')
    return out.map(v => Object.fromEntries(Object.entries(select).filter(([, on]) => on).map(([k, on]) => {
      if (k !== 'run') return [k, v[k]]
      const run = runs.get(v.runId) ?? {}
      const fields = Object.keys(((on as { select?: Row }).select ?? {}))
      return [k, Object.fromEntries(fields.map(f => [f, run[f] ?? null]))]
    })))
  }
  const prisma = new Proxy(fake.prisma, {
    get(target, prop: string | symbol) {
      const model = (target as Record<string | symbol, unknown>)[prop]
      return prop === 'propertyValuation' ? { ...(model as object), findMany } : model
    },
  })
  return { ...fake, prisma }
}

// A run of the monthly valuation job: published 18 days ago, values as of Oct 1.
export function valuationRun(over: Row = {}): Row {
  return {
    id: 'run_oct', organizationId: ORG, runAt: daysAgo(19), asOf: OCT_1, dataThrough: OCT_1, modelVersion: 'test',
    gatesPassed: true, published: true, publishedAt: daysAgo(18), createdAt: daysAgo(19), ...over,
  }
}

// One seller's valuation in a run: $1.83M, likely $1.52M to $2.14M (DRIFT_SCRIPT #12).
let v = 0
export function valuation(contactId: string, over: Row = {}): Row {
  const i = ++v
  return {
    id: `pv_${i}`, runId: 'run_oct', organizationId: ORG, contactId, bbl: '3000010001',
    value: 1_830_000, low: 1_520_000, high: 2_140_000, asOf: OCT_1, reason: null,
    createdAt: daysAgo(18), ...over,
  }
}

// A home the model can't value (lib/valuations/contract.ts): no value, no range, a reason.
export const noValue = (contactId: string, reason: string, over: Row = {}) =>
  valuation(contactId, { value: null, low: null, high: null, reason, ...over })

export const TARGET_LINE = "Our internal estimate is $1.83M, likely $1.52M–$2.14M, as of Oct 1. That's for you only."

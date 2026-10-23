// Brief 48 PR 13: Brief 43 PR 5's where-evaluating stand-in for Prisma
// (lib/chat/__tests__/pr5FakePrisma.ts), plus the two things the Buyer Match
// report and its buyer list ask of the database that it lacks:
//   - `hasSome` on an array column (the off-market section's neighborhoods),
//     read as an OR of `has`;
//   - groupBy over one or more fields with `_count: true` or `_count: { _all: true }`.
// Every where clause is still evaluated, and an unknown operator still throws.
// Made-up people and places only. Not a *.test.ts file.
import { makeFakePrisma as makePr5FakePrisma, matchesWhere, type Row, type Where } from '../../chat/__tests__/pr5FakePrisma'

export { contact, ORG, ORG_ROW, type Row } from '../../chat/__tests__/pr5FakePrisma'

// { neighborhoods: { hasSome: ['A', 'B'] } } → { OR: [{ neighborhoods: { has: 'A' } }, …] }
function withoutHasSome(where: unknown): unknown {
  if (Array.isArray(where)) return where.map(withoutHasSome)
  if (!where || typeof where !== 'object' || where instanceof Date) return where
  const out: Where = {}
  const ors: Where[] = []
  for (const [k, v] of Object.entries(where as Where)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'hasSome' in (v as Where)) {
      ors.push({ OR: ((v as Where).hasSome as unknown[]).map(x => ({ [k]: { has: x } })) })
    } else out[k] = withoutHasSome(v)
  }
  if (ors.length) out.AND = [...(Array.isArray(out.AND) ? out.AND as Where[] : out.AND ? [out.AND as Where] : []), ...ors]
  return out
}

export function makeFakePrisma(tables: Record<string, Row[]>) {
  const fake = makePr5FakePrisma(tables)
  const prisma = new Proxy(fake.prisma, {
    get(target, prop: string | symbol) {
      const model = (target as Record<string | symbol, unknown>)[prop]
      if (typeof prop === 'symbol' || prop === 'then' || prop.startsWith('$') || !model || typeof model !== 'object') return model
      const m = model as Record<string, (args?: Record<string, unknown>) => Promise<unknown>>
      return {
        ...m,
        findMany: (args: Record<string, unknown> = {}) => m.findMany({ ...args, where: withoutHasSome(args.where) as Where }),
        groupBy: async (args: { by: string[]; where?: Where; _count?: true | { _all?: boolean } }) => {
          if (Object.keys(args).some(k => !['by', 'where', '_count'].includes(k))) throw new Error('pr13FakePrisma: unsupported groupBy')
          const groups = new Map<string, { key: Row; n: number }>()
          for (const r of (fake.tables[prop] ?? []).filter(r => matchesWhere(r, args.where))) {
            const key = Object.fromEntries(args.by.map(f => [f, r[f]]))
            const id = JSON.stringify(key)
            const g = groups.get(id) ?? { key, n: 0 }
            g.n++
            groups.set(id, g)
          }
          fake.calls.push({ model: prop, op: 'groupBy', args: args as unknown as Record<string, unknown>, returned: groups.size })
          return [...groups.values()].map(({ key, n }) => ({ ...key, _count: args._count === true ? n : { _all: n } }))
        },
      }
    },
  })
  return { ...fake, prisma }
}

const T0 = Date.UTC(2026, 9, 1)
let i = 0
const next = () => ++i

// An email buyer or renter request (ExtractedOpportunity BUYER_ISO / RENTER_INQUIRY),
// stored the way mapISO stores one (lib/extraction/schemas.ts): `beds` and `price`
// hold the range's midpoint ("3-4 BR" is beds 3.5), or a lone min or max, unless
// the test sets them (review r1).
export function emailBuyer(over: Row = {}): Row {
  const n = next()
  const row: Row = {
    id: `buyer_${n}`, organizationId: 'org_pr5', category: 'BUYER_ISO', extractedTitle: `Example buyer request ${n}`,
    neighborhoods: ['Park Slope'], neighborhood: null, borough: 'Brooklyn',
    minBeds: 3, maxBeds: 4, minPrice: 1_500_000, maxPrice: 2_000_000,
    mustHaves: null, dealbreakers: null, timeline: null, propertyTypes: [], isTestData: true,
    isDuplicate: false, processingStatus: 'active',
    createdAt: new Date(T0 + n * 60_000), updatedAt: new Date(T0 + n * 60_000),
    ...over,
  }
  const num = (k: string) => (row[k] as number | null | undefined) ?? null
  const [minB, maxB, minP, maxP] = [num('minBeds'), num('maxBeds'), num('minPrice'), num('maxPrice')]
  if (!('beds' in over)) row.beds = minB != null && maxB != null ? (minB + maxB) / 2 : maxB ?? minB
  if (!('price' in over)) row.price = minP && maxP ? Math.round((minP + maxP) / 2) : maxP ?? minP
  return row
}

// A listing from an email (ExtractedOpportunity on the supply side). Public, so
// its address may show.
export function emailListing(over: Row = {}): Row {
  const n = next()
  return {
    id: `listing_${n}`, organizationId: 'org_pr5', category: 'ACTIVE_SALE_LISTING',
    address: `${10 + n} Sample St`, neighborhood: 'Park Slope', neighborhoods: [], borough: 'Brooklyn',
    price: 1_800_000, minPrice: null, maxPrice: null, beds: 3, baths: 2, squareFeet: 2000, units: null,
    propertyType: 'Townhouse', extractedTitle: `Townhouse on Sample St ${n}`, extractedSummary: '',
    sourceBrokerage: 'Example Realty', sourceAgentName: 'Jordan Sample', availabilityDate: null,
    isTestData: true, isDuplicate: false, processingStatus: 'active',
    createdAt: new Date(T0 + n * 60_000), updatedAt: new Date(T0 + n * 60_000),
    ...over,
  }
}

// A Match row with a listing on the supply side and a buyer as the counterpart.
export function listingMatch(listingId: string, buyerId: string, over: Row = {}): Row {
  const n = next()
  return {
    id: `match_${n}`, organizationId: 'org_pr5', opportunityId: listingId, opportunityType: 'opportunity',
    counterpartId: buyerId, counterpartType: 'opportunity', score: 90 - n % 10, tier: 'HOT',
    reason: 'Exact Park Slope match with the price inside the budget', seen: false,
    createdAt: new Date(T0 + n * 60_000),
    ...over,
  }
}

// A stand-in for fetch that answers only FRED's 30-year rate (6.30%, down from
// 6.40%) and refuses every other address. Returns a restore function.
export function fakeFredRate(): () => void {
  const realFetch = globalThis.fetch
  const realKey = process.env.FRED_API_KEY
  process.env.FRED_API_KEY = 'not-a-real-key'
  globalThis.fetch = (async (url: string | URL) => {
    if (!String(url).startsWith('https://api.stlouisfed.org/')) throw new Error(`pr13FakePrisma: network refused: ${String(url).slice(0, 40)}`)
    return new Response(JSON.stringify({ observations: [{ date: '2026-10-15', value: '6.30' }, { date: '2026-10-08', value: '6.40' }] }), { status: 200 })
  }) as typeof fetch
  return () => {
    globalThis.fetch = realFetch
    if (realKey === undefined) delete process.env.FRED_API_KEY
    else process.env.FRED_API_KEY = realKey
  }
}

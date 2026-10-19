// Brief 47 (PR 1): an in-memory stand-in for every database call the nightly's
// scoring and call-list steps make (lib/matching/nightly/runScoring.ts,
// lib/ranking/queueBuilder.ts, lib/nightlyPipeline.ts), so their tests run with
// no database. Unlike memoryDb.ts it keeps real transactions: a throw inside
// $transaction puts every table back and drops the writes it made. The nightly's
// raw statements (the size check's count, the Match upsert, the stale-row
// delete) are done in memory the way Postgres runs them. Every seller, buyer,
// phone and value is invented. Import this FIRST: it points lib/prisma at the
// stand-in (lib/prisma uses globalThis.prisma when it is set). Not a *.test.ts file.
import { matchesWhere, type Row } from '../../../__tests__/memoryDb'
import { DELETE_STALE_MATCHES_SQL, EXISTING_MATCH_COUNTS_SQL, UPSERT_MATCHES_SQL } from '../sql'

const TABLES = [
  'organization', 'mojoContact', 'extractedOpportunity', 'matchDismissal', 'featureFlag', 'propertyValuation',
  'match', 'auditLog', 'callQueueEntry',
] as const
export type TableName = (typeof TABLES)[number]
export type Tables = Record<TableName, Row[]>
export type Write = { op: string; args: unknown }

export const ORG_ID = 'org-test'
const SCORER_COLUMNS = ['score', 'tier', 'reason', 'captureStatus', 'matchFitConfidence', 'contributions', 'unknownFactors']
const pairKey = (m: Row) => `${m.opportunityId}|${m.counterpartId}|${m.counterpartType}`
const pick = (row: Row, select?: Row): Row =>
  select ? Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, row[k]])) : { ...row }

export function nightlyWorld(init: Partial<Tables> = {}, opts: { countFails?: boolean } = {}) {
  let data = structuredClone(Object.fromEntries(TABLES.map(t => [t, init[t] ?? []])) as Tables)
  const writes: Write[] = [] // committed writes, in order
  const calls: { op: string; tx: boolean }[] = [] // every call, reads too, and whether it ran in a transaction
  let pending: Write[] | null = null // the open transaction's writes
  let viaTx = false // the call came through the transaction's own client (not the global one)
  let nextId = 1
  const read = (op: string) => { calls.push({ op, tx: viaTx }) }
  const write = (op: string, args: unknown) => {
    calls.push({ op, tx: viaTx })
    ;(viaTx && pending ? pending : writes).push({ op, args })
  }

  const model = (name: TableName) => ({
    findMany: async (a: { where?: Row; select?: Row } = {}) => {
      read(`${name}.findMany`)
      return data[name].filter(r => matchesWhere(r, a.where)).map(r => pick(r, a.select))
    },
    findUnique: async (a: { where: Row; select?: Row }) => {
      read(`${name}.findUnique`)
      const r = data[name].find(x => matchesWhere(x, a.where))
      return r ? pick(r, a.select) : null
    },
    findUniqueOrThrow: async (a: { where: Row; select?: Row }) => {
      read(`${name}.findUniqueOrThrow`)
      const r = data[name].find(x => matchesWhere(x, a.where))
      if (!r) throw new Error(`No ${name} found`)
      return pick(r, a.select)
    },
    create: async (a: { data: Row }) => {
      const row = { id: `${name}_${nextId++}`, createdAt: new Date(), ...a.data }
      data[name].push(row)
      write(`${name}.create`, a.data)
      return row
    },
    createMany: async (a: { data: Row[] }) => {
      data[name].push(...a.data)
      write(`${name}.createMany`, a.data.length)
      return { count: a.data.length }
    },
    deleteMany: async (a: { where?: Row } = {}) => {
      const before = data[name].length
      data[name] = data[name].filter(r => !matchesWhere(r, a.where))
      write(`${name}.deleteMany`, a.where)
      return { count: before - data[name].length }
    },
    updateMany: async (a: { where?: Row; data: Row }) => {
      const hit = data[name].filter(r => matchesWhere(r, a.where))
      for (const r of hit) Object.assign(r, a.data)
      write(`${name}.updateMany`, a)
      return { count: hit.length }
    },
  })

  // The rows DELETE_STALE_MATCHES_SQL can delete: this org's, contact supply, the
  // supply a non-test MojoContact.
  const jobOwned = (m: Row, orgId: unknown) => m.organizationId === orgId && m.opportunityType === 'contact' &&
    data.mojoContact.some(c => c.id === m.opportunityId && !c.isTestData)

  // UPSERT_MATCHES_SQL: insert new pairs; update an existing contact-supply pair of
  // this org only when a scorer output changed. RETURNING gives one row per insert
  // or update, none for a pair left as it was.
  function upsertMatches(rows: Row[], orgId: unknown) {
    const out: { inserted: boolean }[] = []
    for (const r of rows) {
      const old = data.match.find(m => pairKey(m) === pairKey(r))
      if (!old) {
        data.match.push({ ...r, organizationId: orgId, opportunityType: 'contact', seen: false, createdAt: new Date() })
        out.push({ inserted: true })
        continue
      }
      if (old.opportunityType !== 'contact' || old.organizationId !== orgId) continue
      if (SCORER_COLUMNS.every(k => JSON.stringify(old[k] ?? null) === JSON.stringify(r[k] ?? null))) continue
      for (const k of SCORER_COLUMNS) old[k] = r[k]
      out.push({ inserted: false })
    }
    write('match.upsert', rows.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'id')))) // the ids are random
    return out
  }

  const base: Row = {
    ...Object.fromEntries(TABLES.map(t => [t, model(t)])),
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      if (sql === EXISTING_MATCH_COUNTS_SQL) {
        read('match.counts')
        if (opts.countFails) throw new Error('Connection terminated unexpectedly')
        const owned = data.match.filter(m => jobOwned(m, params[0]))
        return [{ matches: owned.length, sellers: new Set(owned.map(m => m.opportunityId)).size }]
      }
      if (sql === UPSERT_MATCHES_SQL) return upsertMatches(JSON.parse(params[0] as string) as Row[], params[1])
      throw new Error(`unexpected query: ${sql.replace(/\s+/g, ' ').slice(0, 80)}`)
    },
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      if (sql !== DELETE_STALE_MATCHES_SQL) throw new Error(`unexpected statement: ${sql.replace(/\s+/g, ' ').slice(0, 80)}`)
      const kept = new Set((JSON.parse(params[1] as string) as Row[]).map(pairKey))
      const gone = data.match.filter(m => jobOwned(m, params[0]) && !kept.has(pairKey(m)))
      data.match = data.match.filter(m => !gone.includes(m))
      write('match.deleteStale', gone.map(pairKey).sort())
      return gone.length
    },
    $transaction: async (arg: unknown) => {
      // The array form (the call list's persistBatch): its calls already ran.
      if (Array.isArray(arg)) return Promise.all(arg)
      if (pending) throw new Error('nested transaction')
      const snapshot = structuredClone(data)
      pending = []
      try {
        const out = await (arg as (tx: unknown) => Promise<unknown>)(txClient)
        writes.push(...pending)
        return out
      } catch (e) {
        data = snapshot // a throw rolls back: tables and writes as before
        throw e
      } finally {
        pending = null
      }
    },
  }

  // The client a $transaction callback gets. Calls through it are the transaction's;
  // a call through the global client while a transaction is open is not (as in Prisma,
  // where it runs on another connection). Each model call records synchronously.
  const inTx = (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => {
    const prev = viaTx
    viaTx = true
    try { return fn(...a) } finally { viaTx = prev }
  }
  const txClient: Row = new Proxy(base, {
    get: (t, p) => {
      const v = t[p as string]
      if (typeof v === 'function') return inTx(v as (...a: unknown[]) => unknown)
      if (v && typeof v === 'object') {
        return new Proxy(v as Row, { get: (m, q) => (typeof m[q as string] === 'function' ? inTx(m[q as string] as (...a: unknown[]) => unknown) : m[q as string]) })
      }
      return v
    },
  })

  return {
    db: base,
    get data() { return data },
    writes,
    calls,
  }
}
export type NightlyWorld = ReturnType<typeof nightlyWorld>

// The stand-in lib/prisma hands out. Swap `current.world` between cases.
export const current: { world: NightlyWorld } = { world: nightlyWorld() }
;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy({}, {
  get: (_t, prop) => current.world.db[prop as string],
})

// ── A made-up org ───────────────────────────────────────────────────────────

export function crmSeller(id: string, n: number, over: Row = {}): Row {
  return {
    id, mojoId: `77001${String(n).padStart(2, '0')}`, organizationId: ORG_ID, isTestData: false, intent: 'SELLER',
    tags: [], groups: [], metadata: { source: 'crm' }, fullName: `Test Owner ${id}`, address: '123 Example St',
    alternateAddress: null, neighborhood: 'Park Slope', initialNeighborhood: null, zipCode: '11215', propertyBeds: 3,
    propertyBaths: 2, unitCount: 1, propertyTypeDetail: 'Single Family Residence', estimatedValue: null,
    priorListingStatus: null, priorListingPrice: null, yearBuilt: 1910, lotSizeSqft: 2000, buildingSqft: 2400,
    zoningCode: 'R6B', equityBalance: null, currentLTV: null, totalLoanBalance: null, loanInterestRate: null,
    preForeclosureStatus: null, foreclosureAuctionDate: null, isVacant: null, ownerOccupied: false,
    lastSaleDate: new Date('1998-06-01'), mojoList: null, batchRankCategory: null, budgetMin: null, budgetMax: null,
    bedsMin: null, bedsMax: null, notes: null, cashOnly: null, timing: null, status: null,
    phone: `21255501${String(n).padStart(2, '0')}`, additionalPhones: [], phoneDncFlags: [false], phoneTypes: ['mobile'],
    lastCalled: null, lastDialDate: null, createdAt: new Date('2026-09-01'), ...over,
  }
}

export function isoBuyer(id: string, over: Row = {}): Row {
  return {
    id, organizationId: ORG_ID, isTestData: true, category: 'BUYER_ISO', transactionType: 'BUYER_NEED',
    neighborhood: null, neighborhoods: ['Park Slope'], price: null, minPrice: null, maxPrice: null, beds: null,
    minBeds: 3, maxBeds: 5, bathsMin: null, bathsMax: null, propertyTypes: [], mustHaves: null, dealbreakers: null,
    buyerArchetype: null, timeline: null, monthlyMaintenance: null, monthlyCommonCharges: null, monthlyTaxes: null,
    createdAt: new Date('2026-10-01'), ...over,
  }
}

export const SELLERS = Array.from({ length: 12 }, (_, i) =>
  crmSeller(`seller-${String(i).padStart(2, '0')}`, i, i % 3 === 0 ? { neighborhood: 'Gowanus' } : {}))
// Test buyers only, as in the test-data phase (SCORING_INCLUDE_TEST_BUYERS=true).
export const BUYERS = [
  isoBuyer('buyer-a', { maxPrice: 1_600_000 }),
  isoBuyer('buyer-b', { minPrice: 1_200_000, maxPrice: 2_000_000, buyerArchetype: 'FIRST_TIME_FHA' }),
  isoBuyer('buyer-c', { maxPrice: 1_800_000, buyerArchetype: 'LUXURY_FINANCED' }),
  isoBuyer('buyer-d', { neighborhoods: ['Gowanus', 'Park Slope'], maxPrice: 2_200_000, buyerArchetype: 'CASH_BUYER' }),
]
export const MOJO_BUYER = crmSeller('buyer-mojo', 90, {
  intent: 'BUYER', isTestData: true, metadata: {}, budgetMax: 1_500_000, bedsMin: 3, cashOnly: true,
})

export const SWITCH_ON = { id: 'USE_OUR_ESTIMATES', enabled: true }
const published = (contactId: string, value: number) => ({
  id: `pv-${contactId}`, organizationId: ORG_ID, contactId, value, createdAt: new Date('2026-10-17'),
  run: { published: true, publishedAt: new Date('2026-10-17T15:00:00Z') },
})
export const GOOD_VALUES = SELLERS.map((s, i) => published(s.id as string, 1_000_000 + i * 25_000)) // inside the budgets
export const BAD_VALUES = SELLERS.map(s => published(s.id as string, 6_000_000)) // far above every budget

// A Match row as an earlier night left it.
export function oldMatch(opportunityId: string, counterpartId: string, over: Row = {}): Row {
  return {
    id: `old-${opportunityId}-${counterpartId}`, organizationId: ORG_ID, opportunityId, opportunityType: 'contact',
    counterpartId, counterpartType: 'opportunity', score: 61, tier: 'POSSIBLE', reason: 'an earlier night',
    captureStatus: 'EXTERNAL_BOTH', matchFitConfidence: 'MEDIUM', contributions: { neighborhood: 40 }, unknownFactors: [],
    seen: true, createdAt: new Date('2026-10-10T09:00:00Z'), ...over,
  }
}

// Sellers, test buyers, and an empty Match table, unless `over` says otherwise.
export function orgTables(over: Partial<Tables> = {}): Partial<Tables> {
  return {
    organization: [{ id: ORG_ID, slug: 'dealflow-ryan' }],
    mojoContact: [...SELLERS, MOJO_BUYER],
    extractedOpportunity: BUYERS,
    ...over,
  }
}

// A non-CRM contact that is still real (an old csv import): not scored, but its
// matches are in the stale-row delete's scope, so the size check counts them.
export const legacyContact = (id: string, n: number) => crmSeller(id, n, { metadata: { source: 'csv' }, mojoId: `csv_${n}` })

// Brief 44 (PR 4): nightly scoring with the USE_OUR_ESTIMATES switch, end to end on
// an in-memory stand-in for Prisma (no database, no network). Off: one switch read
// and nothing else changes. On: CRM sellers are priced by our published values, the
// night is also scored without them, and the results without them are written
// (with an AuditLog row and the switch turned off) when ours fail the rollback
// checks. Runs under tsx; every seller, buyer and value is invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'

type Row = Record<string, unknown>
const omit = (o: Row, k: string): Row => Object.fromEntries(Object.entries(o).filter(([x]) => x !== k))

const contact = (id: string, over: Row = {}): Row => ({
  id, organizationId: 'org-test', isTestData: false, intent: 'SELLER', tags: [], metadata: { source: 'crm' },
  fullName: null, address: '123 Example St', alternateAddress: null, neighborhood: 'Park Slope', initialNeighborhood: null,
  zipCode: '11215', propertyBeds: 3, propertyBaths: 2, unitCount: 1, propertyTypeDetail: 'Single Family Residence',
  estimatedValue: null, priorListingStatus: null, priorListingPrice: null, yearBuilt: 1910, lotSizeSqft: 2000,
  buildingSqft: 2400, zoningCode: 'R6B', equityBalance: null, currentLTV: null, totalLoanBalance: null,
  loanInterestRate: null, preForeclosureStatus: null, foreclosureAuctionDate: null, isVacant: null,
  ownerOccupied: false, lastSaleDate: new Date('1998-06-01'), mojoList: null, batchRankCategory: null,
  budgetMin: null, budgetMax: null, bedsMin: null, bedsMax: null, notes: null, cashOnly: null, timing: null,
  createdAt: new Date('2026-09-01'), ...over,
})
const SELLERS = Array.from({ length: 12 }, (_, i) => contact(`seller-${String(i).padStart(2, '0')}`, i % 3 === 0 ? { neighborhood: 'Gowanus' } : {}))
const iso = (id: string, over: Row = {}): Row => ({
  id, organizationId: 'org-test', isTestData: true, category: 'BUYER_ISO', transactionType: 'BUYER_NEED',
  neighborhood: null, neighborhoods: ['Park Slope'], price: null, minPrice: null, maxPrice: null, beds: null,
  minBeds: 3, maxBeds: 5, bathsMin: null, bathsMax: null, propertyTypes: [], mustHaves: null, dealbreakers: null,
  buyerArchetype: null, timeline: null, createdAt: new Date('2026-10-01'), ...over,
})
const ISO_BUYERS = [
  iso('buyer-a', { maxPrice: 1_600_000 }),
  iso('buyer-b', { minPrice: 1_200_000, maxPrice: 2_000_000, buyerArchetype: 'FIRST_TIME_FHA' }),
  iso('buyer-c', { maxPrice: 1_800_000, buyerArchetype: 'LUXURY_FINANCED' }),
]
const MOJO_BUYERS = [contact('buyer-mojo', { intent: 'BUYER', metadata: {}, budgetMax: 1_500_000, bedsMin: 3, cashOnly: true })]

const published = (contactId: string, value: number | null) =>
  ({ contactId, value, createdAt: new Date('2026-10-17'), run: { publishedAt: new Date('2026-10-17T15:00:00Z') } })
const GOOD_VALUES = SELLERS.map((s, i) => published(s.id as string, 1_000_000 + i * 25_000)) // inside the budgets
const BAD_VALUES = SELLERS.map(s => published(s.id as string, 6_000_000)) // far above every budget

// The stand-in. `state` decides what the switch and the valuation reads return.
const state = {
  flag: null as unknown, // the FeatureFlag row; 'throw' makes the read fail
  values: [] as unknown, // PropertyValuation rows; 'throw' makes the read fail
  reads: [] as string[],
  committed: [] as Array<[string, unknown]>,
}
const reset = (flag: unknown, values: unknown = []) => {
  state.flag = flag
  state.values = values
  state.reads = []
  state.committed = []
}
const txClient = (pending: Array<[string, unknown]>) => ({
  $queryRawUnsafe: async (_sql: string, rows: string) => {
    const parsed = JSON.parse(rows) as Row[]
    pending.push(['upsert', parsed.map(r => omit(r, 'id'))])
    return parsed.map(() => ({ inserted: true }))
  },
  $executeRawUnsafe: async () => 0,
  // The run time (ms) is left out so two nights can be compared.
  auditLog: { create: async ({ data }: { data: Row }) => { pending.push([`audit:${data.action}`, omit(data.detailsJson as Row, 'ms')]); return data } },
  featureFlag: { updateMany: async (a: unknown) => { pending.push(['featureFlag.updateMany', a]); return { count: 1 } } },
})
;(globalThis as unknown as { prisma: unknown }).prisma = {
  organization: { findUniqueOrThrow: async () => ({ id: 'org-test' }) },
  mojoContact: { findMany: async ({ where }: { where: Row }) => (where.intent === 'BUYER' ? MOJO_BUYERS : SELLERS) },
  extractedOpportunity: { findMany: async ({ where }: { where: Row }) => (where.category === 'BUYER_ISO' ? ISO_BUYERS : []) },
  matchDismissal: { findMany: async () => [] },
  featureFlag: {
    findUnique: async () => {
      state.reads.push('featureFlag')
      if (state.flag === 'throw') throw new Error('connection reset')
      return state.flag
    },
  },
  propertyValuation: {
    findMany: async () => {
      state.reads.push('propertyValuation')
      if (state.values === 'throw') throw new Error('relation "PropertyValuation" does not exist')
      return state.values
    },
  },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const pending: Array<[string, unknown]> = []
    const out = await fn(txClient(pending)) // a throw rolls back: nothing pending is kept
    state.committed.push(...pending)
    return out
  },
}
process.env.SCORING_INCLUDE_TEST_BUYERS = 'true' // the test-data phase, as in production

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { warn, error } = console
  console.warn = () => {}
  console.error = () => {}
  try { return await fn() } finally { console.warn = warn; console.error = error }
}
async function night(flag: unknown, values: unknown = [], dryRun = false) {
  const { runNightlyScoring } = await import('../nightly/runScoring')
  reset(flag, values)
  const result = await quiet(() => runNightlyScoring({ dryRun }))
  const stable = omit(result as Row, 'ms')
  return { result, stable, reads: [...state.reads], committed: [...state.committed] }
}
const upserts = (committed: Array<[string, unknown]>) => committed.filter(([k]) => k === 'upsert').flatMap(([, v]) => v as Row[])
const kinds = (committed: Array<[string, unknown]>) => committed.map(([k]) => k)

test('switch off: one switch read, no valuation read, and the night is scored and written as before', async () => {
  const off = await night(null)
  assert.deepEqual(off.reads, ['featureFlag'])
  assert.deepEqual(kinds(off.committed), ['upsert', 'audit:NIGHTLY_SCORING'])
  assert.equal('ourEstimates' in off.result, false)
  assert.ok(upserts(off.committed).length > 0)
  // Price sits out for every seller (no price), as today.
  assert.ok(upserts(off.committed).every(r => !('price' in (r.contributions as Row))))
  // enabled false, a string "true" and a failed read are all the same night.
  for (const flag of [{ enabled: false }, { enabled: 'true' }, 'throw']) {
    const same = await night(flag)
    assert.deepEqual(same.reads, ['featureFlag'], JSON.stringify(flag))
    assert.deepEqual(same.stable, off.stable, JSON.stringify(flag))
    assert.deepEqual(same.committed, off.committed, JSON.stringify(flag))
  }
})

test('switch on: CRM sellers are priced by our published values, and nothing rolls back', async () => {
  const off = await night(null)
  const on = await night({ enabled: true }, GOOD_VALUES)
  assert.deepEqual(on.reads, ['featureFlag', 'propertyValuation'])
  assert.deepEqual(kinds(on.committed), ['upsert', 'audit:NIGHTLY_SCORING'])
  const check = on.result.ourEstimates
  assert.equal(check?.rolledBack, false)
  assert.equal(check?.sellersPricedByOurValue, SELLERS.length)
  assert.deepEqual(check?.reasons, [])
  // The price factor now votes on the pairs with a budget.
  assert.ok(upserts(on.committed).some(r => 'price' in (r.contributions as Row)))
  assert.notDeepEqual(upserts(on.committed), upserts(off.committed))
  // The scoring result carries the check (counts only) next to the usual numbers.
  const audit = on.committed.find(([k]) => k === 'audit:NIGHTLY_SCORING')![1] as Row
  assert.deepEqual(audit.ourEstimates, check)
})

test('switch on, values that would cost the matches: the night is written without them and the switch goes off', async () => {
  const off = await night(null)
  const on = await night({ enabled: true }, BAD_VALUES)
  const check = on.result.ourEstimates!
  assert.equal(check.rolledBack, true)
  assert.deepEqual(check.reasons, ['hot_halved', 'sellers_lost_matches'])
  assert.equal(check.hotWith, 0)
  assert.equal(check.sellersLosingAllMatches, SELLERS.length)
  // The Match rows written are exactly the switch-off night's.
  assert.deepEqual(upserts(on.committed), upserts(off.committed))
  assert.deepEqual(kinds(on.committed), ['upsert', 'audit:VALUATION_SWITCH_ROLLBACK', 'featureFlag.updateMany', 'audit:NIGHTLY_SCORING'])
  assert.deepEqual(on.committed[1][1], check)
  assert.deepEqual(on.committed[2][1], { where: { id: 'USE_OUR_ESTIMATES' }, data: { enabled: false } })
  // The usual numbers are the switch-off night's too.
  assert.deepEqual(omit(on.stable, 'ourEstimates'), off.stable)
})

test('switch on, our values unreadable: the night is written without them and the switch goes off', async () => {
  const off = await night(null)
  const on = await night({ enabled: true }, 'throw')
  assert.deepEqual(on.result.ourEstimates?.reasons, ['error'])
  assert.deepEqual(upserts(on.committed), upserts(off.committed))
  assert.ok(kinds(on.committed).includes('featureFlag.updateMany'))
})

test('a dry run reports what would happen and writes nothing', async () => {
  const dry = await night({ enabled: true }, BAD_VALUES, true)
  assert.equal(dry.result.dryRun, true)
  assert.equal(dry.result.ourEstimates?.rolledBack, true)
  assert.deepEqual(dry.committed, [])
})

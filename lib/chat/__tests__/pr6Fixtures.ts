// Brief 43 PR 6: fixtures for the matches-by-seller tests, on top of PR 5's
// fake Prisma (pr5FakePrisma.ts, which evaluates every where clause and throws
// on an operator it doesn't know). Fictional people only (Brief 43 HELPER_RULES
// rule 7): "Probe" names, Example streets, the 555-01xx range. Not a *.test.ts file.
import { contact, makeFakePrisma as makePr5FakePrisma, matchesWhere, ORG, type Row, type Where } from './pr5FakePrisma'

export { contact, sixHundredFifty, ORG, ORG_ROW, type Row } from './pr5FakePrisma'

// PR 5's fake plus groupBy({ by: [one field], where, _count: { _all: true } }),
// evaluated over the table like every other call, and logged.
export function makeFakePrisma(tables: Record<string, Row[]>) {
  const fake = makePr5FakePrisma(tables)
  const prisma = new Proxy(fake.prisma, {
    get(target, prop: string | symbol) {
      const model = (target as Record<string | symbol, unknown>)[prop]
      if (typeof prop === 'symbol' || prop === 'then' || prop.startsWith('$') || !model || typeof model !== 'object') return model
      return {
        ...(model as object),
        groupBy: async (args: { by: string[]; where?: Where; _count?: { _all?: boolean } }) => {
          if (args.by.length !== 1 || Object.keys(args).some(k => !['by', 'where', '_count'].includes(k))) throw new Error('pr6Fixtures: unsupported groupBy')
          const groups = new Map<unknown, number>()
          for (const r of (fake.tables[prop] ?? []).filter(r => matchesWhere(r, args.where))) groups.set(r[args.by[0]], (groups.get(r[args.by[0]]) ?? 0) + 1)
          fake.calls.push({ model: prop, op: 'groupBy', args: args as unknown as Record<string, unknown>, returned: groups.size })
          return [...groups].map(([k, n]) => ({ [args.by[0]]: k, _count: { _all: n } }))
        },
      }
    },
  })
  return { ...fake, prisma }
}

const T_NIGHTLY = Date.UTC(2026, 9, 19, 9, 0, 0)

let m = 0
// A nightly Match row: the seller is the supply side (opportunityType 'contact').
export function match(over: Row = {}): Row {
  const i = ++m
  return {
    id: `match_${String(i).padStart(4, '0')}`, organizationId: ORG,
    opportunityType: 'contact', opportunityId: 'mc_none',
    counterpartType: 'opportunity', counterpartId: `iso_none_${i}`,
    score: 70, tier: 'WARM', reason: 'Right neighborhood, bedroom count', seen: false,
    createdAt: new Date(T_NIGHTLY + i * 1000),
    captureStatus: 'EXTERNAL_BOTH', matchFitConfidence: 'MEDIUM', contributions: {}, unknownFactors: [],
    ...over,
  }
}

let b = 0
// An inbox buyer request (another agent's email): an ExtractedOpportunity BUYER_ISO.
// The agent's name, phone and email are filled in so a test can check they
// never reach Drift or the card.
export function isoBuyer(over: Row = {}): Row {
  const i = ++b
  return {
    id: `iso_${String(i).padStart(4, '0')}`, organizationId: ORG, category: 'BUYER_ISO',
    address: null, neighborhood: 'Bedford-Stuyvesant', borough: 'Brooklyn', neighborhoods: ['Bedford-Stuyvesant'],
    propertyTypes: ['2-Family', '3-Family'], beds: null, minBeds: 3, maxBeds: null,
    price: null, minPrice: 1_350_000, maxPrice: 2_600_000, buyerArchetype: 'CASH_BUYER', isTestData: true,
    sourceAgentName: `Probe Agent ${i}`, sourceBrokerage: 'Example Realty', sourceAgentPhone: '7185550177',
    sourceAgentEmail: `probe.agent${i}@example.test`, extractedTitle: `Probe buyer request ${i}`, extractedSummary: '',
    ...over,
  }
}

// A buyer stored in Ryan's CRM table (MojoContact, intent BUYER).
export function crmBuyer(over: Row = {}): Row {
  return contact({
    intent: 'BUYER', isTestData: true, fullName: 'Probe Crm Buyer', phone: '7185550188', address: null,
    neighborhood: null, initialNeighborhood: 'Crown Heights', bedsMin: 2, bedsMax: 3,
    budgetMin: 900_000, budgetMax: 1_200_000, cashOnly: false, metadata: { source: 'csv' },
    ...over,
  })
}

// The seller's row on the nightly call list (the list the CRM card's buyers come from).
export function queueEntry(contactId: string, matchIds: string[], over: Row = {}): Row {
  return {
    id: `cqe_${contactId}`, organizationId: ORG, contactId, rank: 1, priorityScore: 80, reason: 'Top match',
    primaryMatchId: matchIds[0] ?? null, contributingMatchIds: matchIds.slice(1), contributions: {},
    generationRunId: 'run_pr6', generatedAt: new Date(T_NIGHTLY), ...over,
  }
}

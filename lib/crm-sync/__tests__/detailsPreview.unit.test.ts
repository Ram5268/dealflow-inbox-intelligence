import { test } from 'node:test'
import assert from 'node:assert/strict'

// Brief 48 (PR 9): the seller-details preview loads tonight's scoring inputs with its own
// loader, never priced by DealFlow's own values (lib/crm-sync/detailsPreview.ts). Pinned
// here to the nightly's own loader with the USE_OUR_ESTIMATES switch off, on a fake
// database, so the two can't drift apart. Pure: no database.
type Row = Record<string, unknown>
const seller = (id: string, extra: Row = {}): Row => ({
  id, mojoId: `m_${id}`, fullName: 'Test Owner', organizationId: 'org_1', isTestData: false, intent: 'SELLER', tags: [], groups: [],
  neighborhood: 'Bedford-Stuyvesant', zipCode: '11221', propertyTypeDetail: 'Duplex', unitCount: 2, propertyBeds: 6, propertyBaths: 2,
  estimatedValue: null, priorListingStatus: null, priorListingPrice: null, metadata: { source: 'crm' }, createdAt: new Date('2026-09-25T12:00:00Z'), ...extra,
})
const buyer = (id: string, extra: Row = {}): Row => ({
  ...seller(id), intent: 'BUYER', metadata: null, neighborhood: 'Bedford-Stuyvesant', bedsMin: 2, bedsMax: 4, budgetMin: 900_000, budgetMax: 1_800_000, cashOnly: true, ...extra,
})

function fakeDb() {
  const sellers = [seller('s1'), seller('s2', { tags: ['ryan_listing'] })]
  const buyers = [buyer('b1'), buyer('b2', { tags: ['ryan_buyer'] }), buyer('b3', { isTestData: true }), buyer('b4', { neighborhood: 'Nowhere Special' })]
  return {
    mojoContact: {
      findMany: async ({ where }: { where: Row }) =>
        where.intent === 'BUYER' ? buyers.filter(b => where.isTestData === undefined || b.isTestData === where.isTestData) : sellers,
    },
    extractedOpportunity: { findMany: async () => [] },
    matchDismissal: { findMany: async () => [{ partyId: 'b1', listingId: 's1' }] },
    featureFlag: { findUnique: async () => null }, // USE_OUR_ESTIMATES off
    propertyValuation: { findMany: async () => { throw new Error('our values must not be read') } },
  }
}

const comparable = (x: { ctx: { now: Date } } & Row) => ({ ...x, ctx: { ...x.ctx, now: null } })

test('the preview\'s loader gives exactly what the nightly\'s loader gives with the switch off, test buyers in or out', async () => {
  ;(globalThis as unknown as { prisma?: unknown }).prisma ??= {} // lib/prisma is never used: the fake is passed in
  const { loadScoringInputs } = await import('../../matching/nightly/runScoring')
  const { scoringInputsWithoutOurValues } = await import('../detailsPreview')
  for (const include of ['true', undefined]) {
    if (include) process.env.SCORING_INCLUDE_TEST_BUYERS = include
    else delete process.env.SCORING_INCLUDE_TEST_BUYERS
    const nightly = await loadScoringInputs('org_1', fakeDb() as never)
    const mine = await scoringInputsWithoutOurValues(fakeDb() as never, 'org_1')
    assert.equal(nightly.ourEstimates, undefined)
    assert.deepEqual(comparable(mine as never), comparable(nightly as never))
    assert.equal(mine.buyers.length, include ? 3 : 2) // the buyer with no known neighborhood is left out either way
    assert.deepEqual([...mine.ctx.ryanOwnedListingIds], ['s2'])
  }
  delete process.env.SCORING_INCLUDE_TEST_BUYERS
})

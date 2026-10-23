import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import {
  makeFakePrisma, contact, sixHundredFifty, match, isoBuyer, crmBuyer, queueEntry, ORG_ROW, type Row,
} from '../../__tests__/pr6Fixtures'

// Brief 43 PR 6 (N1, M-01): "which buyers match [one of my sellers]?" Buyers-
// for-a-seller questions are allowed under D11 [Ryan, 2026-10-18], for ONE
// seller named by name or by street address (D13 [Ryan, 2026-10-19]). The
// buyers come back with the same rows, order and tiers as /api/matches and the
// seller's CRM card. Pure: fake Prisma that evaluates every where clause.
const fake = makeFakePrisma({ organization: [ORG_ROW] })
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

const t = (s: number) => new Date(Date.UTC(2026, 9, 19, 9, 0, s))

// Pat Example (88 Example Ave) has seven buyers and one dismissed pair; the
// homeowner at 188 Example Ave has two of their own; another org's row and an
// email listing's match are noise.
function world(over: { contacts?: Row[]; matches?: Row[]; queue?: Row[] } = {}) {
  const pat = contact({
    id: 'mc_pat', fullName: 'Pat Example', phone: '7185550142', address: '88 Example Ave', neighborhood: 'Bedford-Stuyvesant',
    metadata: { source: 'crm', crmLeadId: 'lead_pat', lastCallResult: 'Left Message' },
  })
  const at188 = contact({ id: 'mc_188', fullName: 'Jordan Sample', address: '188 Example Ave', neighborhood: 'Bedford-Stuyvesant' })
  const isos = ['a', 'b', 'c', 'e', 'f', 'g', 'x', 'y'].map(k => isoBuyer({ id: `iso_${k}` }))
  isos[1] = isoBuyer({ id: 'iso_b', propertyTypes: ['Co-op'], neighborhoods: [], neighborhood: 'Park Slope', minBeds: null, maxBeds: null, beds: 2, minPrice: null, maxPrice: null, price: 950_000, buyerArchetype: null, isTestData: false })
  const buyer = crmBuyer({ id: 'mc_buyer' })
  fake.tables.mojoContact = [pat, at188, buyer, ...(over.contacts ?? [])]
  fake.tables.extractedOpportunity = isos
  fake.tables.match = over.matches ?? [
    match({ id: 'm_a', opportunityId: 'mc_pat', counterpartId: 'iso_a', score: 92, tier: 'HOT', reason: 'Right neighborhood, in budget; weaker on bedrooms', createdAt: t(1) }),
    match({ id: 'm_b', opportunityId: 'mc_pat', counterpartId: 'iso_b', score: 88, tier: 'HOT', createdAt: t(2) }),
    match({ id: 'm_c', opportunityId: 'mc_pat', counterpartId: 'iso_c', score: 88, tier: 'HOT', createdAt: t(3) }),
    match({ id: 'm_d', opportunityId: 'mc_pat', counterpartType: 'mojo', counterpartId: 'mc_buyer', score: 81, tier: 'HOT', createdAt: t(4) }),
    match({ id: 'm_e', opportunityId: 'mc_pat', counterpartId: 'iso_e', score: 70, tier: 'WARM', createdAt: t(5) }),
    match({ id: 'm_f', opportunityId: 'mc_pat', counterpartId: 'iso_f', score: 66, tier: 'WARM', createdAt: t(6) }),
    match({ id: 'm_g', opportunityId: 'mc_pat', counterpartId: 'iso_g', score: 58, tier: 'POSSIBLE', createdAt: t(7) }),
    match({ id: 'm_x', opportunityId: 'mc_pat', counterpartId: 'iso_x', score: 95, tier: 'HOT', createdAt: t(8) }), // dismissed
    match({ id: 'm_188a', opportunityId: 'mc_188', counterpartId: 'iso_a', score: 99, tier: 'HOT', createdAt: t(9) }),
    match({ id: 'm_188b', opportunityId: 'mc_188', counterpartId: 'iso_y', score: 75, tier: 'WARM', createdAt: t(10) }),
    match({ id: 'm_other_org', organizationId: 'org_other', opportunityId: 'mc_pat', counterpartId: 'iso_y', score: 99, tier: 'HOT', createdAt: t(11) }),
    match({ id: 'm_listing', opportunityType: 'opportunity', opportunityId: 'eo_listing', counterpartId: 'iso_a', score: 97, tier: 'HOT', createdAt: t(12) }),
  ]
  fake.tables.matchDismissal = [{ id: 'd1', partyId: 'iso_x', listingId: 'mc_pat' }]
  fake.tables.callQueueEntry = over.queue ?? []
  fake.calls.length = 0
}

// The /matches function itself (GET /api/matches), run on the same rows.
async function matchesPageList(): Promise<Array<{ id: string; tier: string | null; reason: string | null; primary: { id: string } | null }>> {
  const { GET } = await import('../../../../app/api/matches/route')
  const res = await GET(new NextRequest('http://localhost/api/matches'))
  assert.equal(res.status, 200)
  return (await res.json() as { matches: Array<{ id: string; tier: string | null; reason: string | null; primary: { id: string } | null }> }).matches
}

test('the buyers come back in the same order, with the same tiers and fit lines, as the /matches function', async () => {
  world()
  const { getSellerMatches } = await import('../sellerMatches')
  const r = await getSellerMatches({ name: 'Pat Example' })
  assert.ok('seller' in r)
  const page = (await matchesPageList()).filter(m => m.primary?.id === 'mc_pat')
  assert.deepEqual(r.buyers.map(b => b.matchId), page.map(m => m.id))
  assert.deepEqual(r.buyers.map(b => b.matchId), ['m_a', 'm_c', 'm_b', 'm_d', 'm_e', 'm_f', 'm_g'])
  assert.deepEqual(r.buyers.map(b => b.tier), page.map(m => m.tier))
  assert.deepEqual(r.buyers.map(b => b.fit), page.map(m => m.reason))
})

test('ties follow the seller\'s call-list entry, so the first five are the CRM card\'s five in its order', async () => {
  // The CRM card's buyers: the entry's primary + contributing matches, best
  // score first, ties in the entry's order (the CRM's BUYERS_SQL). Here the
  // entry has m_b before m_c (they tie at 88).
  world({ queue: [queueEntry('mc_pat', ['m_a', 'm_b', 'm_c', 'm_d', 'm_e'])] })
  const { getSellerMatches } = await import('../sellerMatches')
  const r = await getSellerMatches({ name: 'Pat Example' })
  assert.ok('seller' in r)
  assert.deepEqual(r.buyers.slice(0, 5).map(b => b.matchId), ['m_a', 'm_b', 'm_c', 'm_d', 'm_e'])
  assert.deepEqual(r.buyers.map(b => b.matchId), ['m_a', 'm_b', 'm_c', 'm_d', 'm_e', 'm_f', 'm_g'])
})

test('a match Ryan already opened on /matches keeps its place, as on the CRM card', async () => {
  world()
  fake.tables.match.find(m => m.id === 'm_a')!.seen = true
  const { getSellerMatches } = await import('../sellerMatches')
  const r = await getSellerMatches({ name: 'Pat Example' })
  assert.ok('seller' in r)
  assert.equal(r.buyers[0].matchId, 'm_a')
  // The Matches page itself lists unopened matches first.
  const page = (await matchesPageList()).filter(m => m.primary?.id === 'mc_pat')
  assert.equal(page[page.length - 1].id, 'm_a')
})

test('only this seller\'s own matches, without the pair Ryan dismissed; the count and tiers are over all of them', async () => {
  world()
  const { getSellerMatches } = await import('../sellerMatches')
  const r = await getSellerMatches({ name: 'Pat Example' })
  assert.ok('seller' in r)
  const ids = r.buyers.map(b => b.matchId)
  for (const id of ['m_x', 'm_188a', 'm_188b', 'm_other_org', 'm_listing']) assert.ok(!ids.includes(id), id)
  assert.equal(r.count, 7)
  assert.deepEqual(r.tiers, { hot: 4, warm: 2, possible: 1 })
  assert.equal(r.matchesUrl, '/matches?m=m_a')
  // The seller, shaped so Brief 43 PR 3's draft check knows this homeowner.
  // Brief 43 PR 12: plus our estimate and the prior listing (none in this fixture).
  assert.deepEqual(r.seller, {
    kind: 'crm_seller', id: 'mc_pat', name: 'Pat Example', address: '88 Example Ave', neighborhood: 'Bedford-Stuyvesant', doNotContact: false,
    internalEstimate: null, priorListingStatus: null, priorListingPrice: null,
  })
})

test('each buyer: what they want, HOT or WARM, the score, a plain fit line, the test label and a /matches link', async () => {
  world()
  const { getSellerMatches } = await import('../sellerMatches')
  const r = await getSellerMatches({ name: 'Pat Example' })
  assert.ok('seller' in r)
  const by = Object.fromEntries(r.buyers.map(x => [x.matchId, x]))
  assert.deepEqual(by.m_a, {
    matchId: 'm_a', tier: 'HOT', score: 92,
    wants: '2–3 family · Bedford-Stuyvesant · 3+ BR · $1.35M–$2.6M · cash',
    // A homeowner's price is never named (Brief 41 H7): "in budget" is dropped.
    fit: 'Right neighborhood; weaker on bedrooms',
    isTestData: true, matchesUrl: '/matches?m=m_a',
  })
  assert.equal(by.m_b.wants, 'Co-op · Park Slope · 2 BR · $950K')
  assert.equal(by.m_b.isTestData, false)
  // A buyer stored in Ryan's CRM.
  assert.equal(by.m_d.wants, 'Crown Heights · 2–3 BR · $900K–$1.2M')
  assert.equal(by.m_d.tier, 'HOT')
  assert.equal(by.m_g.tier, 'POSSIBLE')
  // No buyer's or agent's name, phone or email anywhere in the result.
  const json = JSON.stringify(r)
  for (const s of ['Probe Agent', 'Example Realty', '555-0177', '5550177', 'example.test', 'Probe Crm Buyer', '5550188']) assert.ok(!json.includes(s), s)
})

test('a seller outside the newest 500 is found, by name and by address, with their buyers', async () => {
  const rows = sixHundredFifty()
  const oldest = rows[0]
  world({ contacts: rows, matches: [match({ id: 'm_old', opportunityId: oldest.id as string, counterpartId: 'iso_a', score: 84, tier: 'HOT' })] })
  const { getSellerMatches } = await import('../sellerMatches')
  for (const ask of [{ name: oldest.fullName as string }, { address: oldest.address as string }]) {
    const r = await getSellerMatches(ask)
    assert.ok('seller' in r, JSON.stringify(ask))
    assert.equal(r.seller.id, oldest.id)
    assert.deepEqual(r.buyers.map(b => b.matchId), ['m_old'])
  }
  // The seller lookups never read a newest-N window.
  for (const c of fake.calls.filter(c => c.model === 'mojoContact')) assert.ok(c.args?.take === undefined || (c.args.take as number) <= 10)
})

test('an address lookup for 88 never answers with 188 (or 1088)', async () => {
  world({ contacts: [contact({ id: 'mc_1088', fullName: 'Probe Seller Ten', address: '1088 Example Ave' })] })
  const { getSellerMatches } = await import('../sellerMatches')
  const r = await getSellerMatches({ address: '88 Example Avenue' })
  assert.ok('seller' in r)
  assert.equal(r.seller.id, 'mc_pat')
  assert.ok(!r.buyers.some(b => b.matchId.startsWith('m_188')))
  // Without Pat on file, 88 finds nobody, not the homeowner at 188.
  fake.tables.mojoContact = fake.tables.mojoContact.filter(c => c.id !== 'mc_pat')
  assert.deepEqual(await getSellerMatches({ address: '88 Example Ave' }), { none: true })
})

test('two sellers with the name: candidates (name and neighborhood only); nobody: none', async () => {
  world({ contacts: [contact({ id: 'mc_pat2', fullName: 'Pat Example', neighborhood: 'Crown Heights' })] })
  const { getSellerMatches } = await import('../sellerMatches')
  const r = await getSellerMatches({ name: 'Pat Example' })
  assert.ok('candidates' in r)
  assert.equal(r.candidates.length, 2)
  for (const c of r.candidates) assert.deepEqual(Object.keys(c).sort(), ['id', 'kind', 'name', 'neighborhood'])
  assert.deepEqual(await getSellerMatches({ name: 'Nobody Fictional' }), { none: true })
  assert.deepEqual(await getSellerMatches({}), { none: true })
})

test('a same-name seller Ryan picks by neighborhood: that one\'s buyers (find_seller\'s neighborhood pick)', async () => {
  world({ contacts: [contact({ id: 'mc_pat2', fullName: 'Pat Example', address: '12 Sample St', neighborhood: 'Crown Heights' })] })
  fake.tables.match.push(match({ id: 'm_pat2', opportunityId: 'mc_pat2', counterpartId: 'iso_a', score: 77, tier: 'WARM' }))
  const { getSellerMatches } = await import('../sellerMatches')
  const r = await getSellerMatches({ name: 'Pat Example', neighborhood: 'Crown Heights' })
  assert.ok('seller' in r)
  assert.equal(r.seller.id, 'mc_pat2')
  assert.deepEqual(r.buyers.map(b => b.matchId), ['m_pat2'])
  const other = await getSellerMatches({ name: 'Pat Example', neighborhood: 'Bed-Stuy' })
  assert.ok('seller' in other)
  assert.equal(other.seller.id, 'mc_pat')
  // A neighborhood alone looks up nobody.
  assert.deepEqual(await getSellerMatches({ neighborhood: 'Crown Heights' }), { none: true })
})

test('the tool tells Drift it takes the picked neighborhood, as find_seller does', async () => {
  const { GET_SELLER_MATCHES_TOOL, FIND_SELLER_TOOL } = await import('../schemas')
  const props = (t: { input_schema: unknown }) => (t.input_schema as { properties: Record<string, { description?: string }> }).properties
  assert.ok(props(GET_SELLER_MATCHES_TOOL).neighborhood, 'get_seller_matches has a neighborhood field')
  assert.equal(props(GET_SELLER_MATCHES_TOOL).neighborhood.description, props(FIND_SELLER_TOOL).neighborhood.description)
})

test('what Drift reads: the buyers and counts, with no link and no match id', async () => {
  world()
  const { getSellerMatches, getSellerMatchesForModel } = await import('../sellerMatches')
  const seen = JSON.stringify(getSellerMatchesForModel(await getSellerMatches({ name: 'Pat Example' })))
  assert.ok(!/https?:|\/matches/.test(seen), 'no link (any URL in Drift\'s text trips the guard, Q19)')
  assert.ok(!seen.includes('m_a'), 'no match id')
  assert.ok(seen.includes('"kind":"crm_seller"'))
  assert.ok(seen.includes('2–3 family · Bedford-Stuyvesant · 3+ BR · $1.35M–$2.6M · cash'))
  assert.ok(seen.includes('"testBuyer":true'))
  assert.ok(!seen.includes('isTestData'))
  assert.ok(seen.includes('"count":7'))
})

test('at most 10 buyers listed, best first; the count is all of them', async () => {
  const many = Array.from({ length: 12 }, (_, i) => match({ id: `m_${String(i).padStart(2, '0')}`, opportunityId: 'mc_pat', counterpartId: 'iso_a', score: 90 - i, tier: 'HOT', createdAt: t(i) }))
  world({ matches: many })
  const { getSellerMatches } = await import('../sellerMatches')
  const r = await getSellerMatches({ name: 'Pat Example' })
  assert.ok('seller' in r)
  assert.equal(r.count, 12)
  assert.equal(r.buyers.length, 10)
  assert.equal(r.buyers[0].matchId, 'm_00')
})

test('a row with no stored tier is labeled by the tier thresholds (lib/matching/tiers.ts)', async () => {
  world({ matches: [
    match({ id: 'm_l1', opportunityId: 'mc_pat', counterpartId: 'iso_a', score: 85, tier: null }),
    match({ id: 'm_l2', opportunityId: 'mc_pat', counterpartId: 'iso_c', score: 70, tier: null }),
    match({ id: 'm_l3', opportunityId: 'mc_pat', counterpartId: 'iso_e', score: 55, tier: null }),
  ] })
  const { getSellerMatches } = await import('../sellerMatches')
  const r = await getSellerMatches({ name: 'Pat Example' })
  assert.ok('seller' in r)
  assert.deepEqual(r.buyers.map(b => b.tier), ['HOT', 'WARM', 'POSSIBLE'])
  assert.deepEqual(r.tiers, { hot: 1, warm: 1, possible: 1 })
})

test('a seller with no buyers yet: count 0 and no link', async () => {
  world({ matches: [] })
  const { getSellerMatches } = await import('../sellerMatches')
  const r = await getSellerMatches({ name: 'Pat Example' })
  assert.ok('seller' in r)
  assert.equal(r.count, 0)
  assert.deepEqual(r.buyers, [])
  assert.equal(r.matchesUrl, null)
})

test('an opted-out homeowner is marked do not contact on the result', async () => {
  world()
  fake.tables.mojoContact.find(c => c.id === 'mc_pat')!.metadata = { source: 'crm', crmLeadId: 'lead_pat', crmOptOut: true }
  const { getSellerMatches } = await import('../sellerMatches')
  const r = await getSellerMatches({ name: 'Pat Example' })
  assert.ok('seller' in r)
  assert.equal(r.seller.doNotContact, true)
})

test('test mode never reaches CRM sellers', async () => {
  world()
  process.env.TEST_MODE_ONLY = 'true'
  try {
    const { getSellerMatches } = await import('../sellerMatches')
    assert.deepEqual(await getSellerMatches({ name: 'Pat Example' }), { none: true })
  } finally {
    delete process.env.TEST_MODE_ONLY
  }
})

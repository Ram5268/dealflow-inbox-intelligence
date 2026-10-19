import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { makeFakePrisma, contact, match, isoBuyer, crmBuyer, ORG, ORG_ROW, type Row } from '../../__tests__/pr6Fixtures'

// Brief 43 PR 6 review (#11: the same buyers, in the same order, as the CRM
// card). Builds the seller's call-list entry with the REAL queue builder
// (loadMatchBuckets + rankContact, as the nightly does; read, not edited), then
// reads it the way the CRM's BUYERS_SQL does (entry order, JOIN Match, LIMIT 5,
// then score DESC, ord) and compares with get_seller_matches' first five, over
// random sellers with many ties, dismissals and a shuffled table. Fictional data.
const fake = makeFakePrisma({ organization: [ORG_ROW] })
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

// Deterministic PRNG.
let seed = 12345
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const pickOne = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]
function shuffle<T>(xs: T[]): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] }
  return a
}
const tierOfScore = (s: number) => (s >= 80 ? 'HOT' : s >= 65 ? 'WARM' : 'POSSIBLE')

function seller(id: string, name: string, over: Row = {}): Row {
  return contact({
    id, fullName: name, tags: [], groups: [], phoneTypes: [], lastCalled: null, lastDialDate: null,
    preForeclosureStatus: null, isVacant: null, ...over,
  })
}

// The CRM card's buyers (BUYERS_SQL): unnest(primary || contributing) WITH ORDINALITY,
// JOIN Match (drops ids that no longer exist), ORDER BY ord LIMIT 5, then jsonb_agg
// ORDER BY score DESC, ord.
function crmCard(entry: { primaryMatchId: string | null; contributingMatchIds: string[] } | null): string[] {
  if (!entry) return [] // not in the latest batch: the CRM drops the signal ("No matching buyers yet")
  const byId = new Map(fake.tables.match.map(m => [m.id as string, m]))
  const inner = [entry.primaryMatchId, ...entry.contributingMatchIds]
    .map((id, i) => ({ id: id as string, ord: i + 1 }))
    .filter(x => x.id != null && byId.has(x.id))
    .slice(0, 5)
  return inner.sort((a, b) => (byId.get(b.id)!.score as number) - (byId.get(a.id)!.score as number) || a.ord - b.ord).map(x => x.id)
}

async function nightlyEntry(sellerRow: Row) {
  const { loadMatchBuckets, queueMatchWhere, rankContact } = await import('../../../ranking/queueBuilder')
  const buckets = await loadMatchBuckets(fake.prisma as never, queueMatchWhere(ORG, [sellerRow.id as string]))
  const ranked = rankContact(sellerRow as never, buckets.get(sellerRow.id as string) ?? [], { now: new Date(Date.UTC(2026, 9, 19, 9, 5)) })
  if (ranked.excluded) return null
  return { primaryMatchId: ranked.entry.primaryMatchId, contributingMatchIds: ranked.entry.contributingMatchIds }
}

function randomWorld(trial: number) {
  const s = seller('mc_s', 'Pat Example', { address: '88 Example Ave' })
  const n = pickOne([0, 1, 3, 5, 6, 7, 10, 12, 14])
  const scores = [95, 92, 88, 88, 88, 81, 80, 80, 80, 70, 66, 66, 58, 52, 50]
  const isos: Row[] = []
  const rows: Row[] = []
  for (let i = 0; i < n; i++) {
    const id = `iso_${trial}_${i}`
    isos.push(isoBuyer({ id, isTestData: rnd() < 0.5 }))
    const score = pickOne(scores)
    rows.push(match({
      id: `m_${trial}_${String(i).padStart(2, '0')}`, opportunityId: 'mc_s', counterpartId: id, score, tier: tierOfScore(score),
      seen: rnd() < 0.3, createdAt: new Date(Date.UTC(2026, 9, 1 + Math.floor(rnd() * 18))),
    }))
  }
  // Noise: another seller's rows, listing rows.
  rows.push(match({ id: `m_${trial}_other`, opportunityId: 'mc_other', counterpartId: 'iso_noise', score: 99, tier: 'HOT' }))
  const dismissals: Row[] = []
  for (const r of rows) if (r.opportunityId === 'mc_s' && rnd() < 0.15) dismissals.push({ id: `d_${r.id}`, partyId: r.counterpartId, listingId: 'mc_s' })
  fake.tables.mojoContact = [s, seller('mc_other', 'Jordan Sample', { address: '12 Sample St' })]
  fake.tables.extractedOpportunity = [...isos, isoBuyer({ id: 'iso_noise' })]
  // The database returns rows in no particular order: shuffle the table so the
  // queue builder's stable sort sees ties in a random order.
  fake.tables.match = shuffle(rows)
  fake.tables.matchDismissal = dismissals
  fake.tables.callQueueEntry = []
  return s
}

test('over 300 random sellers, the first five equal the CRM card (entry built by the real queue builder)', async () => {
  const { getSellerMatches } = await import('../sellerMatches')
  let compared = 0
  let withTiesAtBoundary = 0
  for (let trial = 0; trial < 300; trial++) {
    const s = randomWorld(trial)
    const entry = await nightlyEntry(s)
    if (entry) fake.tables.callQueueEntry = [{ id: 'cqe', organizationId: ORG, contactId: 'mc_s', rank: 1, priorityScore: 50, reason: 'x', generationRunId: 'run', generatedAt: new Date(), contributions: {}, ...entry }]
    const r = await getSellerMatches({ name: 'Pat Example' })
    assert.ok('seller' in r)
    const card = crmCard(entry)
    const ours = r.buyers.slice(0, 5).map(b => b.matchId)
    assert.deepEqual(ours, card, `trial ${trial}`)
    // and the stored tiers come along unchanged
    for (const b of r.buyers) assert.equal(b.tier, fake.tables.match.find(m => m.id === b.matchId)!.tier)
    compared++
    const kept = r.buyers.map(b => b.score)
    if (kept.length > 5 && kept[4] === kept[5]) withTiesAtBoundary++
  }
  assert.equal(compared, 300)
  assert.ok(withTiesAtBoundary > 5, `ties straddling the 5th place were exercised (${withTiesAtBoundary})`)
})

test('POSSIBLE-tier and test buyers are listed like the CRM card; a crmBuyer counterpart works', async () => {
  const s = seller('mc_s', 'Pat Example')
  fake.tables.mojoContact = [s, crmBuyer({ id: 'mc_b' })]
  fake.tables.extractedOpportunity = [isoBuyer({ id: 'iso_1', isTestData: true })]
  fake.tables.match = [
    match({ id: 'm_p', opportunityId: 'mc_s', counterpartId: 'iso_1', score: 55, tier: 'POSSIBLE' }),
    match({ id: 'm_c', opportunityId: 'mc_s', counterpartType: 'mojo', counterpartId: 'mc_b', score: 55, tier: 'POSSIBLE' }),
  ]
  fake.tables.matchDismissal = []
  const entry = await nightlyEntry(s)
  fake.tables.callQueueEntry = entry ? [{ id: 'cqe', organizationId: ORG, contactId: 'mc_s', generatedAt: new Date(), ...entry }] : []
  const { getSellerMatches } = await import('../sellerMatches')
  const r = await getSellerMatches({ name: 'Pat Example' })
  assert.ok('seller' in r)
  assert.deepEqual(r.buyers.map(b => b.matchId), crmCard(entry))
  assert.deepEqual(r.buyers.map(b => b.tier), ['POSSIBLE', 'POSSIBLE'])
})

test('a stale stored tier (WARM at score 85) shows as stored, as /matches and the CRM card do', async () => {
  const s = seller('mc_s', 'Pat Example')
  fake.tables.mojoContact = [s]
  fake.tables.extractedOpportunity = [isoBuyer({ id: 'iso_1' })]
  fake.tables.match = [match({ id: 'm_1', opportunityId: 'mc_s', counterpartId: 'iso_1', score: 85, tier: 'WARM' })]
  fake.tables.matchDismissal = []
  fake.tables.callQueueEntry = []
  const { getSellerMatches } = await import('../sellerMatches')
  const r = await getSellerMatches({ name: 'Pat Example' })
  assert.ok('seller' in r)
  assert.equal(r.buyers[0].tier, 'WARM')
  const { GET } = await import('../../../../app/api/matches/route')
  const page = await (await GET(new NextRequest('http://localhost/api/matches'))).json() as { matches: Array<{ id: string; tier: string }> }
  assert.equal(page.matches.find(m => m.id === 'm_1')!.tier, 'WARM')
  const { countMatches } = await import('../countMatches')
  assert.equal((await countMatches({ tier: 'WARM' })).count, 1)
  assert.equal((await countMatches({ tier: 'HOT' })).count, 0)
})

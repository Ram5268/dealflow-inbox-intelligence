import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFakePrisma, contact, match, ORG, ORG_ROW, type Row } from '../../__tests__/pr6Fixtures'
import { tierCounts } from '../../../push/digestCounts'

// Brief 43 PR 6 review: count_matches and count_sellers_with_buyers against a
// brute-force reference on random worlds (tiers stored and null, dismissals in
// both orientations, showing confirmations, other orgs, test / buyer /
// duplicate / other-org contacts), and how many Match rows each count reads:
// a few per dismissal, never every match of a much-matched buyer or every
// seller's matches [engineering precaution]. Fictional ids only.
const fake = makeFakePrisma({ organization: [ORG_ROW] })
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

let seed = 777
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const pickOne = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]

function world(trial: number) {
  const sellers: Row[] = []
  for (let i = 0; i < 12; i++) {
    const kind = pickOne(['ok', 'ok', 'ok', 'test', 'buyer', 'dup', 'otherorg'])
    sellers.push(contact({
      id: `mc_${trial}_${i}`,
      isTestData: kind === 'test',
      intent: kind === 'buyer' ? 'BUYER' : 'SELLER',
      organizationId: kind === 'otherorg' ? 'org_other' : ORG,
      metadata: { source: kind === 'dup' ? 'duplicate' : 'crm' },
    }))
  }
  const rows: Row[] = []
  let k = 0
  for (const s of sellers) {
    const n = Math.floor(rnd() * 6)
    for (let j = 0; j < n; j++) {
      const score = pickOne([95, 85, 80, 79, 70, 65, 64, 55])
      const tier = rnd() < 0.2 ? null : (score >= 80 ? 'HOT' : score >= 65 ? 'WARM' : 'POSSIBLE')
      rows.push(match({ id: `m_${trial}_${k++}`, organizationId: s.organizationId, opportunityId: s.id, counterpartId: `iso_${Math.floor(rnd() * 8)}_${trial}`, score, tier, seen: rnd() < 0.4 }))
    }
  }
  for (let j = 0; j < 8; j++) {
    const score = pickOne([95, 85, 70, 55])
    rows.push(match({ id: `l_${trial}_${j}`, opportunityType: 'opportunity', opportunityId: `eo_${j % 3}`, counterpartId: `iso_${j}_${trial}`, score, tier: rnd() < 0.3 ? null : (score >= 80 ? 'HOT' : score >= 65 ? 'WARM' : 'POSSIBLE'), seen: rnd() < 0.4 }))
  }
  rows.push(match({ id: `sc_${trial}`, opportunityType: 'opportunity', opportunityId: 'eo_0', counterpartType: 'showing_confirmation', counterpartId: 'eo_0', score: 100, tier: null }))
  const dismissals: Row[] = []
  for (const r of rows) {
    if (r.counterpartType === 'showing_confirmation' || rnd() > 0.15) continue
    dismissals.push(rnd() < 0.5
      ? { id: `d_${r.id}`, partyId: r.counterpartId, listingId: r.opportunityId }
      : { id: `d_${r.id}`, partyId: r.opportunityId, listingId: r.counterpartId })
  }
  // de-dup on the unique (partyId, listingId)
  const seen = new Set<string>()
  fake.tables.matchDismissal = dismissals.filter(d => { const key = `${d.partyId}|${d.listingId}`; if (seen.has(key)) return false; seen.add(key); return true })
  fake.tables.mojoContact = sellers
  fake.tables.match = rows
  fake.calls.length = 0
}

const effTier = (m: Row) => (m.tier as string | null) ?? ((m.score as number) >= 80 ? 'HOT' : (m.score as number) >= 65 ? 'WARM' : 'POSSIBLE')
function isDismissed(m: Row) {
  return fake.tables.matchDismissal.some(d =>
    (d.partyId === m.counterpartId && d.listingId === m.opportunityId) || (d.partyId === m.opportunityId && d.listingId === m.counterpartId))
}

test('count_matches equals the brute-force count (and the digest tiering) on 200 random worlds', async () => {
  const { countMatches } = await import('../countMatches')
  for (let trial = 0; trial < 200; trial++) {
    world(trial)
    const live = fake.tables.match.filter(m => m.organizationId === ORG && m.counterpartType !== 'showing_confirmation' && !isDismissed(m))
    const digest = tierCounts(live as Array<{ tier: string | null; score: number }>)
    for (const tier of ['HOT', 'WARM', 'POSSIBLE', 'ALL'] as const) {
      const want = live.filter(m => tier === 'ALL' || effTier(m) === tier)
      const got = await countMatches({ tier })
      assert.deepEqual(got, { tier, count: want.length, unseen: want.filter(m => !m.seen).length }, `trial ${trial} ${tier}`)
      if (tier !== 'ALL') assert.equal(got.count, digest[tier.toLowerCase() as 'hot' | 'warm' | 'possible'])
    }
  }
})

test('count_sellers_with_buyers equals the brute-force count on 200 random worlds', async () => {
  const { countSellersWithBuyers } = await import('../countMatches')
  for (let trial = 0; trial < 200; trial++) {
    world(1000 + trial)
    const pool = new Set(fake.tables.mojoContact
      .filter(c => c.organizationId === ORG && !c.isTestData && c.intent === 'SELLER' && (c.metadata as Row).source === 'crm').map(c => c.id))
    const live = fake.tables.match.filter(m => m.organizationId === ORG && m.opportunityType === 'contact' && pool.has(m.opportunityId) && !isDismissed(m))
    const hw = new Set(live.filter(m => effTier(m) !== 'POSSIBLE').map(m => m.opportunityId))
    const hot = new Set(live.filter(m => effTier(m) === 'HOT').map(m => m.opportunityId))
    assert.deepEqual(await countSellersWithBuyers(), { count: hw.size, withHot: hot.size }, `trial ${trial}`)
  }
})

test('the counts read a few rows per dismissal, not every match', async () => {
  const { countMatches, countSellersWithBuyers } = await import('../countMatches')
  // 1,400 sellers x 10 buyers drawn from 40 much-matched buyers; 3 dismissals of those buyers.
  const rows: Row[] = []
  for (let s = 0; s < 1400; s++) for (let b = 0; b < 10; b++) {
    const score = 60 + ((s * 7 + b * 13) % 40)
    rows.push(match({ id: `m_${s}_${b}`, opportunityId: `mc_${s}`, counterpartId: `iso_${(s + b) % 40}`, score, tier: score >= 80 ? 'HOT' : score >= 65 ? 'WARM' : 'POSSIBLE' }))
  }
  fake.tables.match = rows
  fake.tables.mojoContact = []
  fake.tables.matchDismissal = [
    { id: 'd1', partyId: 'iso_1', listingId: 'mc_0' },
    { id: 'd2', partyId: 'iso_2', listingId: 'mc_1' },
    { id: 'd3', partyId: 'iso_3', listingId: 'mc_2' },
  ]
  const readRows = () => fake.calls.filter(c => c.model === 'match' && c.op === 'findMany').reduce((a, c) => a + c.returned, 0)
  fake.calls.length = 0
  const all = await countMatches({ tier: 'ALL' })
  assert.equal(all.count, 14000 - 3)
  assert.ok(readRows() <= 6, `count_matches read ${readRows()} rows`)
  fake.calls.length = 0
  await countSellersWithBuyers()
  assert.ok(readRows() <= 6, `count_sellers_with_buyers read ${readRows()} rows`)
  assert.ok(fake.calls.filter(c => c.op === 'groupBy').every(c => c.returned <= 1400))
})

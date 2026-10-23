// Brief 48 DS-2: the 45 test buyers and the plan, from made-up facts (no DB).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromRaw } from '../../domain/Neighborhood'
import {
  AGENT_FIRST, AGENT_LAST, EXPECTED_TODAY, HOOD_WEIGHTS, ID_PREFIX, SEED_DOMAIN, TAG, TARGET_TOTAL, TOP_UP, allocate, buildTestBuyers,
  ds2Summary, planDs2, type Ds2Facts,
} from '../ds2TestBuyers'

const facts = (over: Partial<Ds2Facts> = {}): Ds2Facts =>
  ({ orgId: 'org-ryan', testBuyers: 205, realBuyers: 0, testBuyersElsewhere: 45, alreadyThere: 0, anchorId: 'raw-anchor', ...over })

test('205 test buyers today → 45 more, 250 afterwards, no notice', () => {
  assert.equal(TOP_UP, 45)
  assert.equal(TARGET_TOTAL, EXPECTED_TODAY + 45)
  const p = planDs2(facts())
  assert.equal(p.topUp, 45)
  assert.equal(p.buyers.length, 45)
  assert.deepEqual(p.notices, [])
  assert.deepEqual(p.refusals, [])
  const s = ds2Summary(p, facts())
  assert.equal(s.afterwards, 250)
  assert.equal(s.expectedAfterwards, 250)
  assert.equal(s.expect, 45)
})

test('a count other than 205 is called out; exactly 45 are still added and the total is reported', () => {
  for (const [today, total] of [[200, 245], [250, 295]]) {
    const p = planDs2(facts({ testBuyers: today }))
    assert.equal(p.topUp, 45)
    assert.equal(p.buyers.length, 45)
    assert.equal(p.notices.length, 1)
    assert.match(p.notices[0], new RegExp(`Today's count is ${today} test buyers, not the 205.*adding 45 makes ${total}, not 250`))
    assert.deepEqual(p.refusals, [])
    const s = ds2Summary(p, facts({ testBuyers: today }))
    assert.equal(s.afterwards, total)
    assert.equal(s.expect, 45)
  }
})

test('refused: already ran, or no anchor email', () => {
  assert.match(planDs2(facts({ alreadyThere: 45 })).refusals.join(' '), /already there/)
  assert.match(planDs2(facts({ anchorId: null })).refusals.join(' '), /anchor email/)
})

test('the 45 buyers: the same every time, tagged test rows on the anchor email, ids 001–045', () => {
  const a = buildTestBuyers(45, 'org-ryan', 'raw-anchor')
  assert.deepEqual(a, buildTestBuyers(45, 'org-ryan', 'raw-anchor'))
  assert.deepEqual(a.map(b => b.id), Array.from({ length: 45 }, (_, i) => `${ID_PREFIX}${String(i + 1).padStart(3, '0')}`))
  for (const b of a) {
    assert.equal(b.category, 'BUYER_ISO')
    assert.equal(b.transactionType, 'BUYER_NEED')
    assert.equal(b.isTestData, true)
    assert.equal(b.organizationId, 'org-ryan')
    assert.equal(b.rawEmailId, 'raw-anchor')
    assert.ok(b.extractedTitle.startsWith(`${TAG} `))
    assert.equal(b.provenance, 'seed:brief48')
    assert.equal(b.criteriaActive, true)
  }
})

test('aimed at the CRM pool: canonical Brooklyn/Queens neighborhoods, 1–3 family homes, sane budgets and beds', () => {
  const hoods = new Set(HOOD_WEIGHTS.map(([h]) => h))
  for (const b of buildTestBuyers(45, 'o', 'r')) {
    assert.ok(hoods.has(b.neighborhood), b.neighborhood)
    for (const n of b.neighborhoods as string[]) assert.equal(fromRaw(n), n) // the matcher abstains on unknown names
    assert.ok(['Brooklyn', 'Queens'].includes(String(b.borough)), String(b.borough))
    assert.ok((b.propertyTypes as string[]).some(t => /Family|Duplex|Triplex|SFH|Townhouse/.test(t)))
    assert.ok((b.minPrice as number) < (b.maxPrice as number))
    assert.ok((b.maxPrice as number) - (b.minPrice as number) >= 100_000)
    assert.ok((b.minBeds as number) < (b.maxBeds as number))
  }
  // Largest-remainder split by home type, as PR #4: 23/42/35 of 45.
  assert.deepEqual(allocate(45, [['single', 23], ['two', 42], ['three', 35]]), [['single', 10], ['two', 19], ['three', 16]])
})

test('no real person: agents are obviously made up, on the seed domain', () => {
  for (const b of buildTestBuyers(45, 'o', 'r')) {
    const [first, last] = String(b.sourceAgentName).split(' ')
    assert.ok(AGENT_FIRST.includes(first) && AGENT_LAST.includes(last), String(b.sourceAgentName))
    assert.ok(String(b.sourceAgentEmail).endsWith(`@${SEED_DOMAIN}`))
    assert.doesNotMatch(`${b.extractedTitle} ${b.extractedSummary}`, /\d+ [A-Z][a-z]+ (St|Ave|Pl|Rd)\b/) // no street address
  }
  assert.ok(!AGENT_FIRST.includes('Ryan') && !AGENT_LAST.includes('Martin'))
})

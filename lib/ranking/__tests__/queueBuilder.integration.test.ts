// Brief 33 — integration test against the live Railway DB. Inserts [TEST_33]
// fixtures, runs buildCallQueue(persist=false), asserts ordering + filtering,
// then cleans up. Run via tsx (@/-free relative imports + live prisma).
import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../prisma'
import type { Prisma } from '@prisma/client'
import { getCurrentOrgId } from '../../auth/orgContext'
import { buildCallQueue } from '../queueBuilder'

const P = '[TEST_33]'

test('buildCallQueue ranks, filters, and reports stats correctly', async () => {
  const orgId = await getCurrentOrgId()

  // A: strong match, never called, distress → should rank high.
  // B: weak match → should rank well below A.
  // C: DO_NOT_CALL status → excluded regardless of match.
  const mk = (suffix: string, status: string | null) => ({
    organizationId: orgId, mojoId: `TEST33-${suffix}`, fullName: `${P} ${suffix}`,
    intent: 'SELLER', isTestData: true, status,
    phone: '(212) 555-0133', additionalPhones: [] as string[],
    phoneDncFlags: [false], phoneTypes: ['mobile'], tags: ['seller'], groups: [] as string[],
    preForeclosureStatus: 'AUCTION_SCHEDULED', isVacant: true,
  })
  const A = await prisma.mojoContact.create({ data: mk('A-strong', null), select: { id: true } })
  const B = await prisma.mojoContact.create({ data: mk('B-weak', null), select: { id: true } })
  const C = await prisma.mojoContact.create({ data: mk('C-dnc', 'DO_NOT_CALL'), select: { id: true } })

  const match = (contactId: string, score: number, contributions: Record<string, number>): Prisma.MatchCreateManyInput => ({
    organizationId: orgId, opportunityId: contactId, opportunityType: 'contact',
    counterpartId: `test33-buyer-${contactId}`, counterpartType: 'opportunity',
    score, tier: score >= 80 ? 'HOT' : score >= 65 ? 'WARM' : 'POSSIBLE',
    captureStatus: 'OWN_BOTH_SIDES', matchFitConfidence: 'HIGH',
    contributions: contributions as Prisma.InputJsonValue,
  })
  await prisma.match.createMany({
    data: [
      match(A.id, 95, { preForeclosure: 22, foreclosureUrgency: 10, neighborhood: 20 }),
      match(B.id, 52, { neighborhood: 30, price: 20 }),
      match(C.id, 95, { preForeclosure: 22, neighborhood: 20 }),
    ],
  })

  try {
    const { entries, stats } = await buildCallQueue(orgId, 1000, false)

    // Ordering: globally sorted desc.
    for (let i = 1; i < entries.length; i++) {
      assert.ok(entries[i - 1].priorityScore >= entries[i].priorityScore, 'entries must be sorted desc')
    }
    assert.ok(entries.length <= 1000)

    const findRank = (id: string) => entries.find(e => e.contactId === id)
    const a = findRank(A.id)
    const b = findRank(B.id)
    const c = findRank(C.id)

    assert.ok(a, 'strong contact A should be in the queue')
    assert.ok(b, 'weak contact B should be in the queue')
    assert.equal(c, undefined, 'DO_NOT_CALL contact C must be filtered out')

    assert.ok(a!.rank < b!.rank, `A (rank ${a!.rank}) should outrank B (rank ${b!.rank})`)
    assert.ok(a!.priorityScore > b!.priorityScore, 'A should score higher than B')
    // matchFit 95 → matchFitLift dominates the reason (correct); it's a sensible non-empty "why".
    assert.ok(a!.reason.length > 0)
    assert.equal(a!.primaryMatch!.matchFit, 95)

    assert.ok(stats.exclusionCounts.status_do_not_call >= 1, 'C should be counted as status_do_not_call')
    assert.ok(stats.totalContactsConsidered >= 3)
  } finally {
    // Cleanup fixtures.
    await prisma.match.deleteMany({ where: { opportunityId: { in: [A.id, B.id, C.id] } } })
    await prisma.mojoContact.deleteMany({ where: { id: { in: [A.id, B.id, C.id] } } })
    await prisma.$disconnect()
  }
})

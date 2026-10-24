import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFakePrisma, match, ORG_ROW } from '../../__tests__/pr6Fixtures'

// Brief 48 PR 13 (Q44): Drift's NEW MATCHES note read every organization's
// matches (lib/chat/context/matches.ts had no organization filter); the seller
// note was scoped by Brief 43 PR 5. Both the 20 rows and the count now come
// from Ryan's organization only. Stand-in Prisma that evaluates every filter;
// no database.
const fake = makeFakePrisma({ organization: [ORG_ROW] })
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

test("the NEW MATCHES note reads and counts only this organization's matches", async () => {
  fake.tables.match = [
    ...Array.from({ length: 3 }, (_, i) => match({ id: `ours_${i}`, score: 70, seen: false })),
    ...Array.from({ length: 5 }, (_, i) => match({ id: `theirs_${i}`, score: 99, seen: false, organizationId: 'org_other', opportunityType: 'opportunity', reason: 'Other organization match' })),
  ]
  const { matchesFetcher } = await import('../matches')
  const block = (await matchesFetcher({ parsed: {} as never, userMessage: 'any new matches?', queryText: 'any new matches?', isConfirmMessage: false })).block ?? ''
  assert.match(block, /\(all 3 unseen;/)
  assert.doesNotMatch(block, /Other organization/)
  assert.equal(block.trim().split('\n').length, 4)
})

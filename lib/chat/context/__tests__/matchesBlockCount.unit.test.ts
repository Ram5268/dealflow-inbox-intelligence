import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFakePrisma, match, ORG_ROW } from '../../__tests__/pr6Fixtures'

// Brief 43 PR 6 (Q26, M-06): the NEW MATCHES note holds at most 20 rows, but its
// header said "(N total)" with N = those 20, so "how many HOT matches?" could be
// answered as 20. The header now gives the true number of unseen matches it
// draws from (production had 37,563) and points Drift to count_matches.
const fake = makeFakePrisma({ organization: [ORG_ROW] })
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

const run = async (queryText: string) => {
  const { matchesFetcher } = await import('../matches')
  return (await matchesFetcher({ parsed: {} as never, userMessage: queryText, queryText, isConfirmMessage: false })).block
}

test('the header says the 20 shown are the top of M unseen, with the true M', async () => {
  fake.tables.match = [
    ...Array.from({ length: 1234 }, (_, i) => match({ id: `u_${i}`, score: 50 + (i % 50), seen: false })),
    ...Array.from({ length: 3 }, (_, i) => match({ id: `s_${i}`, score: 99, seen: true })),
    ...Array.from({ length: 2 }, (_, i) => match({ id: `low_${i}`, score: 40, seen: false })),
  ]
  const block = await run('any new matches?')
  assert.ok(block)
  assert.match(block, /NEW MATCHES FROM LAST SYNC \(the 20 best-scoring of 1,234 unseen; count_matches has the exact counts by tier\):/)
  assert.ok(!/\(20 total\)/.test(block))
  assert.equal(block.trim().split('\n').length, 21)
})

test('20 or fewer: the header says these are all of them; none: no block', async () => {
  fake.tables.match = Array.from({ length: 3 }, (_, i) => match({ id: `u_${i}`, score: 70, seen: false }))
  assert.match(String(await run('matches?')), /NEW MATCHES FROM LAST SYNC \(all 3 unseen; count_matches has the exact counts by tier\):/)
  fake.tables.match = []
  assert.equal(await run('matches?'), null)
  assert.equal(await run('hello'), null)
})

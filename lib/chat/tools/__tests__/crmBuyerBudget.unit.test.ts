import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFakePrisma, contact, ORG_ROW } from '../../__tests__/pr5FakePrisma'

// Brief 43 PR 7 (Q10) after PR 5: CRM-stored buyers use the same budget test as
// inbox buyers. A buyer is kept when the price falls inside their range, not
// when it's near the middle of it. Pure: fake Prisma, fictional people.
const wide = contact({ id: 'mc_wide', fullName: 'Probe Wide Buyer', intent: 'BUYER', isTestData: true, budgetMin: 1_000_000, budgetMax: 2_000_000, address: null })
const maxOnly = contact({ id: 'mc_max', fullName: 'Probe Max Buyer', intent: 'BUYER', isTestData: true, budgetMin: null, budgetMax: 2_000_000, address: null })
const tooLow = contact({ id: 'mc_low', fullName: 'Probe Low Buyer', intent: 'BUYER', isTestData: true, budgetMin: 600_000, budgetMax: 900_000, address: null })
const fake = makeFakePrisma({ organization: [ORG_ROW], extractedOpportunity: [], mojoContact: [wide, maxOnly, tooLow] })
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

test('a $1.8M home keeps a $1.0M–$2.0M and a max-$2.0M CRM buyer, and drops a $0.6M–$0.9M one', async () => {
  const { searchParties } = await import('../searchParties')
  const ids = (await searchParties({ role: 'buyer', priceRangeOverlaps: { min: 1_800_000, max: 1_800_000 } })).cards.map(c => c.id)
  assert.ok(ids.includes('mc_wide'), 'the $1.0M–$2.0M buyer is kept')
  assert.ok(ids.includes('mc_max'), 'the max-only $2.0M buyer is kept')
  assert.ok(!ids.includes('mc_low'), 'a buyer whose top is $0.9M is not')
})

// Brief 43 PR 14 (Q38): the "Recommended adjustment" section's fallback prose
// (used when no AI client is available) follows the feel standard (Brief 42
// TEST_PLAN §3): no em-dashes, no "!". Pure: a stand-in report context, no
// database, no AI call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recommendedAdjustmentSection } from '../sections/recommended-adjustment'

const BUYER = {
  id: 'b1', neighborhoods: ['Bed-Stuy'], borough: 'Brooklyn', minBeds: 3, maxBeds: 4, beds: null,
  minPrice: 1_500_000, maxPrice: 2_000_000, price: null,
}
const ctxWith = (tiers: string[]) => ({
  buyer: BUYER,
  matches: async () => tiers.map((tier, i) => ({ tier, reason: null, listing: { id: `l${i}`, isHomeowner: false } })),
}) as never

test('the fallback prose has no em-dash or "!", with and without clear fits', async () => {
  const key = process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try {
    const one = await recommendedAdjustmentSection(ctxWith(['HOT', 'WARM']))
    const two = await recommendedAdjustmentSection(ctxWith(['HOT', 'HOT', 'POSSIBLE']))
    const none = await recommendedAdjustmentSection(ctxWith(['WARM']))
    assert.equal(one.content.prose, 'The criteria are clearing inventory, with 1 clear fit on the board. No change needed this period; focus on getting showings booked.')
    assert.equal(two.content.prose, 'The criteria are clearing inventory, with 2 clear fits on the board. No change needed this period; focus on getting showings booked.')
    for (const s of [one, two, none]) {
      const prose = String(s.content.prose)
      assert.ok(!prose.includes('—') && !prose.includes('!'), prose)
    }
  } finally {
    if (key !== undefined) process.env.ANTHROPIC_API_KEY = key
  }
})

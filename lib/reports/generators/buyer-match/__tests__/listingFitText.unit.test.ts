// Brief 48 PR 13 (Q34; Brief 46 drift-1 R-02 residual): a listing's fit line
// in a Buyer Match report was the text an older matcher stored with the match
// (an AI-written sentence from the email-sync engine), passed through as is. It
// could be wrong: "in budget" on $2,030,000 against a $2,000,000 maximum. The
// nightly's own lines can't say that, and only cover homeowners. A listing's
// line is now worked out from the listing's facts against the buyer's criteria.
// Pure: the real loader and sections on a stand-in for Prisma (pr13FakePrisma.ts),
// no database, no network; a stand-in model records what it is given.
// Made-up places only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import type Anthropic from '@anthropic-ai/sdk'
import { makeFakePrisma, emailBuyer, emailListing, listingMatch } from '../../../__tests__/pr13FakePrisma'
import { gatherContext } from '../context'
import { curatedMatchesSection } from '../sections/curated-matches'
import { nearMissesSection } from '../sections/near-misses'
import { recommendedAdjustmentSection } from '../sections/recommended-adjustment'
import { listingFitReason } from '../../../../matching/fitReason'

const buyer = emailBuyer({ id: 'buyer_q34', neighborhoods: ['Park Slope'], minBeds: 3, maxBeds: 4, minPrice: 1_500_000, maxPrice: 2_000_000 })
const over = emailListing({ id: 'over', address: '30 Sample St', neighborhood: 'Park Slope', price: 2_030_000, beds: 3 })
const inside = emailListing({ id: 'inside', address: '31 Sample St', neighborhood: 'Park Slope', price: 1_900_000, beds: 2 })
const elsewhere = emailListing({ id: 'elsewhere', address: '32 Sample St', neighborhood: 'Astoria', price: 1_700_000, beds: 3 })
const STORED_WRONG = 'Exact Park Slope match with $2.03M inside the $1.5-2.0M budget, both fresh'

const fake = makeFakePrisma({
  extractedOpportunity: [buyer, over, inside, elsewhere],
  mojoContact: [],
  match: [
    listingMatch('over', 'buyer_q34', { tier: 'HOT', score: 95, reason: STORED_WRONG }),
    listingMatch('inside', 'buyer_q34', { tier: 'WARM', score: 72, reason: 'Great light and a strong block' }),
    listingMatch('elsewhere', 'buyer_q34', { tier: 'POSSIBLE', score: 55, reason: 'Right neighborhood, in budget' }),
  ],
  matchDismissal: [],
})
const prisma = fake.prisma as unknown as PrismaClient

test("the report's fit line for a listing comes from its facts, not the stored text", async () => {
  const ctx = await gatherContext({ buyerId: 'buyer_q34', prisma })
  const curated = await curatedMatchesSection(ctx)
  const fit = (curated.content.items ?? []).find(i => i.listingId === 'over')?.fit
  assert.equal(fit, 'Right neighborhood, bedroom count; weaker on price')
  assert.doesNotMatch(JSON.stringify(curated), /in budget|inside the|fresh/i)

  const near = await nearMissesSection(ctx)
  const why = new Map((near.content.items ?? []).map(i => [i.listingId, i.why]))
  assert.equal(why.get('inside'), 'Right neighborhood, in budget; weaker on bedrooms')
  assert.equal(why.get('elsewhere'), 'In budget, bedroom count; weaker on location')
  assert.doesNotMatch(near.content.prose ?? '', /strong block|Great light/)
})

test('the recommended-adjustment model is given the same worked-out lines', async () => {
  const seen: string[] = []
  const anthropic = {
    messages: { create: async (args: { messages: Array<{ content: string }> }) => {
      seen.push(args.messages[0].content)
      return { content: [{ type: 'text', text: 'Widen the bedroom count.' }] }
    } },
  } as unknown as Anthropic
  const ctx = await gatherContext({ buyerId: 'buyer_q34', prisma })
  await recommendedAdjustmentSection(ctx, anthropic)
  assert.equal(seen.length, 1)
  assert.match(seen[0], /- Right neighborhood, in budget; weaker on bedrooms/)
  assert.match(seen[0], /- In budget, bedroom count; weaker on location/)
  assert.doesNotMatch(seen[0], /strong block|Great light/)
})

test('listingFitReason: only what the facts show, in the nightly wording', () => {
  const b = { neighborhoods: ['Park Slope'], minPrice: 1_500_000, maxPrice: 2_000_000, price: null, minBeds: 3, maxBeds: 4, beds: null }
  assert.equal(listingFitReason({ neighborhood: 'park slope', price: 2_000_000, beds: 4 }, b), 'Right neighborhood, in budget, bedroom count')
  assert.equal(listingFitReason({ neighborhood: 'Park Slope', price: 2_000_001, beds: 3 }, b), 'Right neighborhood, bedroom count; weaker on price')
  // Below the minimum isn't "in budget", nor a drawback.
  assert.equal(listingFitReason({ neighborhood: 'Park Slope', price: 1_200_000, beds: 3 }, b), 'Right neighborhood, bedroom count')
  // An adjacent neighborhood is neither a strength nor a drawback (as in the nightly).
  assert.equal(listingFitReason({ neighborhood: 'Prospect Heights', price: 1_800_000, beds: null }, b), 'In budget')
  // Nothing known: no line, and the section says it plainly.
  assert.equal(listingFitReason({ neighborhood: null, price: null, beds: null }, b), null)
  // An exact bedroom count, and a buyer with only a price.
  assert.equal(listingFitReason({ neighborhood: null, price: 900_000, beds: 2 }, { ...b, minPrice: null, maxPrice: null, price: 1_000_000, minBeds: null, maxBeds: null, beds: 2 }), 'In budget, bedroom count')
})

// Review r1: an email buyer as mapISO stores it (lib/extraction/schemas.ts):
// "3-4 BR, $1.5-2.0M" keeps beds 3.5 and price $1.75M beside the range, and a
// lone "2+ BR" or "$1.6M+" fills beds or price from it. The line reads the
// range, as nightly matching does (lib/matching/adapters.ts).
test('listingFitReason reads a buyer the way mapISO stores it', () => {
  const range = { neighborhoods: ['Park Slope'], minBeds: 3, maxBeds: 4, beds: 3.5, minPrice: 1_500_000, maxPrice: 2_000_000, price: 1_750_000 }
  assert.equal(listingFitReason({ neighborhood: 'Park Slope', price: 1_800_000, beds: 3 }, range), 'Right neighborhood, in budget, bedroom count')
  assert.equal(listingFitReason({ neighborhood: 'Park Slope', price: 1_800_000, beds: 4 }, range), 'Right neighborhood, in budget, bedroom count')
  assert.equal(listingFitReason({ neighborhood: 'Park Slope', price: 1_800_000, beds: 5 }, range), 'Right neighborhood, in budget; weaker on bedrooms')
  const twoPlus = { neighborhoods: ['Park Slope'], minBeds: 2, maxBeds: null, beds: 2, minPrice: null, maxPrice: null, price: null }
  assert.equal(listingFitReason({ neighborhood: 'Park Slope', price: null, beds: 3 }, twoPlus), 'Right neighborhood, bedroom count')
  const pricePlus = { neighborhoods: ['Park Slope'], minBeds: null, maxBeds: null, beds: null, minPrice: 1_600_000, maxPrice: null, price: 1_600_000 }
  assert.equal(listingFitReason({ neighborhood: 'Park Slope', price: 1_800_000, beds: null }, pricePlus), 'Right neighborhood, in budget')
  assert.equal(listingFitReason({ neighborhood: 'Park Slope', price: 1_500_000, beds: null }, pricePlus), 'Right neighborhood')
  const upTo = { neighborhoods: ['Park Slope'], minBeds: null, maxBeds: 2, beds: 2, minPrice: null, maxPrice: 1_600_000, price: 1_600_000 }
  assert.equal(listingFitReason({ neighborhood: 'Park Slope', price: 1_700_000, beds: 1 }, upTo), 'Right neighborhood, bedroom count; weaker on price')
})

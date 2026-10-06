// Brief 41 (H7) — a homeowner (CRM/Mojo seller) never shows up in a buyer-facing
// report or an outreach draft with our estimated value, their name, or seller
// circumstances (distress, equity, absentee, lead lists). Pure: the real report
// loader and sections run on a stand-in for Prisma, no DB.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Category } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { gatherContext } from '../context'
import { curatedMatchesSection } from '../sections/curated-matches'
import { nearMissesSection } from '../sections/near-misses'
import { budgetRealitySection } from '../sections/budget-reality'
import { recommendedAdjustmentSection } from '../sections/recommended-adjustment'
import { resolveSupply } from '../../../../matching/supplyResolver'
import { draftOutreachSystemPrompt } from '../../../../matching/draftPrompt'
import { reasonOf } from '../../../../matching/nightly/select'

const HOMEOWNER = {
  id: 'mc1', fullName: 'Jane Q Homeowner', address: '361 Degraw St', neighborhood: 'Carroll Gardens',
  estimatedValue: 1_840_000, propertyBeds: 6, buildingSqft: 2800, priorListingBrokerage: null,
}
const NO_ADDRESS = { ...HOMEOWNER, id: 'mc2', address: null }
const BUYER = {
  id: 'b1', category: Category.BUYER_ISO, extractedTitle: 'Investor buyer', neighborhoods: ['Carroll Gardens'], neighborhood: null,
  borough: 'Brooklyn', minBeds: 3, maxBeds: 6, beds: null, minPrice: 1_500_000, maxPrice: 2_500_000, price: null,
  mustHaves: null, dealbreakers: null, timeline: null, propertyTypes: [], isTestData: true, createdAt: new Date(),
}
// What older Match rows hold: raw scorer keys, and legacy model text.
const MATCHES = [
  { id: 'm1', tier: 'HOT', score: 92, reason: 'preForeclosure + highEquity + beds', opportunityId: 'mc1', opportunityType: 'contact' },
  { id: 'm2', tier: 'WARM', score: 72, reason: 'neighborhood + absenteeOwner + price', opportunityId: 'mc2', opportunityType: 'contact' },
  { id: 'm3', tier: 'POSSIBLE', score: 55, reason: 'Seller in pre-foreclosure with high equity, priced at $1.84M', opportunityId: 'mc1', opportunityType: 'contact' },
  { id: 'm4', tier: 'WARM', score: 70, reason: 'Good block; asking $1.84M fits', opportunityId: 'mc2', opportunityType: 'contact' },
]
type Args = { where: { id: { in: string[] } } }
const prisma = {
  extractedOpportunity: { findUnique: async () => BUYER, findMany: async () => [] },
  mojoContact: { findMany: async ({ where }: Args) => [HOMEOWNER, NO_ADDRESS].filter(c => where.id.in.includes(c.id)) },
  match: { findMany: async () => MATCHES },
} as unknown as PrismaClient

const FORBIDDEN: Array<[string, RegExp]> = [
  ['homeowner name', /Jane|Q Homeowner/],
  ['estimated value', /1,?840,?000|1\.84\s?M|\$1\.84|\b657\b/i], // 657 = estimate per square foot
  ['seller circumstances', /preForeclosure|highEquity|absenteeOwner|foreclos|equity|absentee/i],
]
function assertClean(label: string, text: string) {
  for (const [what, re] of FORBIDDEN) assert.doesNotMatch(text, re, `${label} leaks ${what}`)
}

test('the Buyer Match report shows no homeowner name, no estimate and no seller circumstances', async () => {
  const ctx = await gatherContext({ buyerId: 'b1', prisma })
  const listings = await ctx.matches()
  assert.equal(listings.length, 4)
  assert.ok(listings.every(l => l.listing.isHomeowner && l.listing.price === null))
  assert.equal(listings.find(l => l.listing.id === 'mc2')?.listing.extractedTitle, 'Homeowner in Carroll Gardens')

  const curated = await curatedMatchesSection(ctx)
  const near = await nearMissesSection(ctx)
  const budget = await budgetRealitySection(ctx)
  for (const [label, section] of [['curated', curated], ['near-misses', near], ['budget', budget]] as const) {
    assertClean(label, JSON.stringify(section.content))
  }
  assert.equal(curated.content.items?.[0].address, '361 Degraw St')
  assert.equal(curated.content.items?.[0].fit, 'Bedroom count')

  // The AI-written recommendation never sees them either.
  const sent: string[] = []
  const anthropic = {
    messages: { create: async (req: unknown) => { sent.push(JSON.stringify(req)); return { content: [{ type: 'text', text: 'Widen the budget slightly.' }] } } },
  }
  await recommendedAdjustmentSection(ctx, anthropic as never)
  assert.equal(sent.length, 1)
  assertClean('recommendation prompt', sent[0])
})

test('an outreach draft prompt for a homeowner has the address, no name, no estimate, no circumstances', async () => {
  for (const id of ['mc1', 'mc2']) {
    const supply = await resolveSupply(prisma, id, 'contact')
    assert.ok(supply)
    assert.equal(supply.price, null)
    assert.equal(supply.estimatedValue, 1_840_000) // kept internally, never shown
    for (const m of MATCHES) {
      const prompt = draftOutreachSystemPrompt({
        channel: 'email',
        party: { name: 'Buyer Agent', role: 'buyer ISO', budget: '$1.5M–$2.5M', beds: '3–6BR', neighborhood: 'Carroll Gardens' },
        supply,
        matchReason: m.reason,
      })
      assertClean(`draft ${id}/${m.id}`, prompt)
      assert.match(prompt, id === 'mc1' ? /Property: 361 Degraw St/ : /Property: Homeowner in Carroll Gardens/)
      assert.match(prompt, /price on request/)
    }
  }
})

test('new nightly reasons never name a seller-motivation signal', () => {
  const r = reasonOf({ preForeclosure: 40, highEquity: 25, absenteeOwner: 10, neighborhood: 15, beds: 10 })
  assertClean('nightly reason', r)
  assert.equal(r, 'Right neighborhood, bedroom count')
})

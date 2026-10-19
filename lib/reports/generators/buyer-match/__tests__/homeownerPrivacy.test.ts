// Brief 41 (H7) — a homeowner (CRM/Mojo seller) never shows up in a buyer-facing
// report or an outreach draft with our estimated value, their name, or seller
// circumstances (distress, equity, absentee, lead lists). Brief 43 PR 3b
// [Ryan, 2026-10-19]: nor with their street address until they have agreed to
// sell (the CRM's ryan_listing tag; homeownerNoAddress.unit.test.ts has that
// case): the home is described by area and type. Pure: the real report loader
// and sections run on a stand-in for Prisma, no DB. Fictional addresses only.
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
import { FIT_KEYS, NEVER_NAMED, plainFitReason } from '../../../../matching/fitReason'
import { WEIGHTS } from '../../../../matching/weights'
import { scorePair } from '../../../../matching/scorer'
import { makeListing, makeBuyer, makeContext } from '../../../../matching/__tests__/fixtures'
import type { MatchFitResult } from '../../../../matching/scorerTypes'

const HOMEOWNER = {
  id: 'mc1', fullName: 'Jane Q Homeowner', address: '88 Example Ave', neighborhood: 'Carroll Gardens',
  estimatedValue: 1_840_000, propertyBeds: 6, buildingSqft: 2800, priorListingBrokerage: null,
  propertyTypeDetail: 'Townhouse', unitCount: 1, tags: ['seller'],
}
const NO_ADDRESS = { ...HOMEOWNER, id: 'mc2', address: null }
const BUYER = {
  id: 'b1', category: Category.BUYER_ISO, extractedTitle: 'Investor buyer', neighborhoods: ['Carroll Gardens'], neighborhood: null,
  borough: 'Brooklyn', minBeds: 3, maxBeds: 6, beds: null, minPrice: 1_500_000, maxPrice: 2_500_000, price: null,
  mustHaves: null, dealbreakers: null, timeline: null, propertyTypes: [], isTestData: true, createdAt: new Date(),
}
// What older Match rows hold: raw scorer keys (every motivation key), and
// legacy model text.
const MATCHES = [
  { id: 'm1', tier: 'HOT', score: 92, reason: 'preForeclosure + highEquity + beds', opportunityId: 'mc1', opportunityType: 'contact' },
  { id: 'm2', tier: 'WARM', score: 72, reason: 'neighborhood + absenteeOwner + price', opportunityId: 'mc2', opportunityType: 'contact' },
  { id: 'm3', tier: 'POSSIBLE', score: 55, reason: 'Seller in pre-foreclosure with high equity, priced at $1.84M', opportunityId: 'mc1', opportunityType: 'contact' },
  { id: 'm4', tier: 'WARM', score: 70, reason: 'Good block; asking $1.84M fits', opportunityId: 'mc2', opportunityType: 'contact' },
  { id: 'm5', tier: 'POSSIBLE', score: 52, reason: 'vacancy + tenure + freeAndClear', opportunityId: 'mc1', opportunityType: 'contact' },
  { id: 'm6', tier: 'POSSIBLE', score: 51, reason: 'goldenHandcuff + sourceListMotivation + foreclosureUrgency + recency', opportunityId: 'mc2', opportunityType: 'contact' },
  { id: 'm7', tier: 'POSSIBLE', score: 50, reason: 'Inherited townhouse, heirs out of state want out', opportunityId: 'mc1', opportunityType: 'contact' },
  { id: 'm8', tier: 'POSSIBLE', score: 50, reason: 'Owned free and clear by a senior owner downsizing', opportunityId: 'mc2', opportunityType: 'contact' },
]
type Args = { where: { id: { in: string[] } } }
const prisma = {
  extractedOpportunity: { findUnique: async () => BUYER, findMany: async () => [] },
  mojoContact: { findMany: async ({ where }: Args) => [HOMEOWNER, NO_ADDRESS].filter(c => where.id.in.includes(c.id)) },
  match: { findMany: async () => MATCHES },
} as unknown as PrismaClient

const FORBIDDEN: Array<[string, RegExp]> = [
  ['homeowner name', /Jane|Q Homeowner/],
  ['street address', /Example Ave|\b88 Example/i], // [Ryan, 2026-10-19]
  ['estimated value', /1,?840,?000|1\.84\s?M|\$1\.84|\b657\b/i], // 657 = estimate per square foot
  ['seller circumstances', new RegExp([
    'preForeclosure', 'highEquity', 'absenteeOwner', 'freeAndClear', 'goldenHandcuff', 'sourceListMotivation', 'foreclosureUrgency',
    'foreclos', 'equity', 'absentee', 'vacan', 'tenure', 'free and clear', 'inherit', '\\bheirs?\\b', 'deceas', 'out of state',
    '\\bseniors?\\b', 'golden handcuff', 'motivat', 'fresh listing',
  ].join('|'), 'i')],
]
function assertClean(label: string, text: string) {
  for (const [what, re] of FORBIDDEN) assert.doesNotMatch(text, re, `${label} leaks ${what}`)
}

test('the Buyer Match report shows no homeowner name, no street address, no estimate and no seller circumstances', async () => {
  const ctx = await gatherContext({ buyerId: 'b1', prisma })
  const listings = await ctx.matches()
  assert.equal(listings.length, MATCHES.length)
  assert.ok(listings.every(l => l.listing.isHomeowner && l.listing.price === null))
  for (const id of ['mc1', 'mc2']) {
    const l = listings.find(m => m.listing.id === id)?.listing
    assert.deepEqual([l?.address, l?.extractedTitle], [null, 'Townhouse in Carroll Gardens'], id)
  }

  const curated = await curatedMatchesSection(ctx)
  const near = await nearMissesSection(ctx)
  const budget = await budgetRealitySection(ctx)
  for (const [label, section] of [['curated', curated], ['near-misses', near], ['budget', budget]] as const) {
    assertClean(label, JSON.stringify(section.content))
  }
  assert.equal(curated.content.items?.[0].address, 'Townhouse in Carroll Gardens') // area and type, not the address
  assert.equal(curated.content.items?.[0].priceLabel, 'price on request')
  // An older row's raw keys have no direction: neutral words, never "in budget".
  assert.equal(curated.content.items?.[0].fit, 'Matched on bedrooms')

  // The AI-written recommendation never sees them either.
  const sent: string[] = []
  const anthropic = {
    messages: { create: async (req: unknown) => { sent.push(JSON.stringify(req)); return { content: [{ type: 'text', text: 'Widen the budget slightly.' }] } } },
  }
  await recommendedAdjustmentSection(ctx, anthropic as never)
  assert.equal(sent.length, 1)
  assertClean('recommendation prompt', sent[0])
})

test('an outreach draft prompt for a homeowner has area and type, no address, no name, no estimate, no circumstances', async () => {
  for (const id of ['mc1', 'mc2']) {
    const supply = await resolveSupply(prisma, id, 'contact')
    assert.ok(supply)
    assert.equal(supply.price, null)
    assert.ok(!('estimatedValue' in supply), 'our estimate is not carried on supply at all')
    for (const m of MATCHES) {
      const prompt = draftOutreachSystemPrompt({
        channel: 'email',
        party: { name: 'Buyer Agent', role: 'buyer ISO', budget: '$1.5M–$2.5M', beds: '3–6BR', neighborhood: 'Carroll Gardens' },
        supply,
        matchReason: m.reason,
      })
      assertClean(`draft ${id}/${m.id}`, prompt)
      assert.match(prompt, /Property: Townhouse in Carroll Gardens · 6BR · price on request/)
      assert.match(prompt, /price on request/)
    }
  }
})

const mf = (contributions: Record<string, number>, scores: Record<string, number>, homeownerSeller = false): MatchFitResult =>
  ({ matchFit: 70, matchFitConfidence: 'HIGH', contributions, unknownFactors: [], scores, homeownerSeller })

test('new nightly reasons never name a seller-motivation signal', () => {
  const r = reasonOf(mf({ preForeclosure: 40, highEquity: 25, absenteeOwner: 10, neighborhood: 15, beds: 10 }, { preForeclosure: 1, highEquity: 1, absenteeOwner: 1, neighborhood: 1, beds: 1 }))
  assertClean('nightly reason', r)
  assert.equal(r, 'Right neighborhood, bedroom count')
})

// The real scorer, end to end, on CRM sellers as they're synced: outdoor space
// and amenities unknown, no buyer preference for them, baths or type.
const ctx = makeContext({ now: new Date('2026-10-05T12:00:00Z'), substitutionCounts: new Map([['b1', 20]]) })
const crmSeller = (over: Parameters<typeof makeListing>[0]) => makeListing({
  id: 's1', sourceType: 'contact', neighborhood: 'Carroll Gardens', borough: 'Brooklyn', beds: 4, baths: 2,
  propertyType: null, unitCount: 1, buildingSqft: 2400, createdAt: new Date('2026-09-01'), ...over,
})
const buyer = (over: Parameters<typeof makeBuyer>[0] = {}) =>
  makeBuyer({ id: 'b1', neighborhoods: ['Carroll Gardens'], priceMin: 1_500_000, priceMax: 2_000_000, bedsMin: 3, bedsMax: 5, ...over })
const nightlyReason = (l: ReturnType<typeof crmSeller>, b: ReturnType<typeof buyer>) => {
  const r = scorePair(l, b, ctx)
  assert.equal(r.eligibility.eligible, true, r.eligibility.reason)
  return reasonOf(r.matchFit)
}
const NOT_ASKED_OR_ESTIMATE = /budget|price|outdoor|amenit|bathroom|property type|strategy|fresh/i

test('a homeowner our estimate puts over budget: no "in budget", no defaults named as strengths (Brief 41 review)', () => {
  // Estimate $2.6M vs a $1.5–2.0M buyer (about a 1-in-4 chance): capped at POSSIBLE.
  const r = nightlyReason(crmSeller({ price: 2_600_000, estimatedValue: 2_600_000 }), buyer())
  assert.match(r, /^Right neighborhood, bedroom count$/)
  assert.doesNotMatch(r, NOT_ASKED_OR_ESTIMATE)
  // As synced today (no estimate at all).
  assert.match(nightlyReason(crmSeller({ price: null }), buyer()), /^Right neighborhood, bedroom count$/)
  // An expired listing's last asking price inside the budget: the report shows
  // "price on request", so the reason doesn't say "in budget" either.
  const expired = nightlyReason(crmSeller({ price: null, priorListingStatus: 'EXPIRED', priorListingPrice: 1_800_000 }), buyer())
  assert.doesNotMatch(expired, NOT_ASKED_OR_ESTIMATE)
})

test('an adjacent neighborhood is not "right neighborhood"', () => {
  const r = nightlyReason(crmSeller({ price: null, neighborhood: 'Clinton Hill' }), buyer({ neighborhoods: ['Bedford-Stuyvesant'] }))
  assert.doesNotMatch(r, /right neighborhood/i)
  assert.doesNotMatch(r, NOT_ASKED_OR_ESTIMATE)
})

test('a wrong neighborhood (same borough, not adjacent) is named as a drawback', () => {
  assert.equal(reasonOf(mf({ neighborhood: 40, beds: 35, price: 25 }, { neighborhood: 0.3, beds: 1, price: 1 })), 'Bedroom count, in budget; weaker on location')
})

test('every scorer feature is either named as a fit feature or never named', () => {
  assert.deepEqual([...FIT_KEYS, ...NEVER_NAMED].sort(), Object.keys(WEIGHTS).sort())
  assert.equal(FIT_KEYS.filter(k => NEVER_NAMED.has(k)).length, 0)
})

test('an older stored reason: neutral words, motivation and unknown keys dropped', () => {
  assert.equal(plainFitReason('price + neighborhood + beds'), 'Matched on price, neighborhood, bedrooms')
  assert.equal(plainFitReason('price + neighborhood + recency', { homeowner: true }), 'Matched on neighborhood') // price was our estimate; listing date doesn't apply
  assert.equal(plainFitReason('constructor + beds'), 'Matched on bedrooms')
  assert.equal(plainFitReason('freeAndClear + someNewKey'), "Fits the buyer's criteria")
  assert.equal(plainFitReason('goldenHandcuff + toString'), "Fits the buyer's criteria")
  assert.equal(plainFitReason('Right neighborhood, bedroom count; weaker on price'), 'Right neighborhood, bedroom count; weaker on price')
  for (const t of ['Deceased owner, family selling', 'Owner in bankruptcy', 'Short sale approved', 'Bank-owned REO', 'Hardship sale', 'Their agent called back']) {
    const out = plainFitReason(t)
    if (t.startsWith('Their')) assert.equal(out, t) // "their" isn't "heir"
    else assert.equal(out, "Fits the buyer's criteria", t)
  }
})

test('a draft for a legacy row with a Mojo counterpart never carries a dollar figure from the reason', async () => {
  const supply = await resolveSupply(prisma, 'mc1', 'contact')
  assert.ok(supply)
  const opp = { ...supply, opportunityType: 'opportunity', price: 1_200_000 }
  const prompt = draftOutreachSystemPrompt({
    channel: 'text',
    party: { name: 'Jane', role: 'seller lead', budget: null, beds: null, neighborhood: null },
    supply: opp,
    matchReason: "Buyer's budget up to $1.84M fits this listing",
    counterpartType: 'mojo',
  })
  assert.match(prompt, /Match reason: Fits the buyer's criteria/)
  assert.doesNotMatch(prompt, /1\.84/)
})

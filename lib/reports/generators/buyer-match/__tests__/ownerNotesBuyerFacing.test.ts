// Ryan's decision, 2026-10-17: saved seller notes may keep these details.
// Buyer-facing text still never names motivation (engineering precaution,
// Brief 41 H7).
//
// This file pins the second half. A seller lead saved with "estate sale, the
// executor is handling it" (lifeEventsKept.test.ts pins that it's saved): the
// fit line the scorer builds for it never names it, and a Buyer Match report
// never shows it, with or without an address. No matcher puts a lead or a
// client conversation on a match's supply side (ownerNotesNeverSupply.test.ts),
// so the report rows here are the old or odd rows the report guards against:
// it shows them exactly like a homeowner, so (Brief 43 PR 3b, [Ryan,
// 2026-10-19]) by area and type, never the street address. Pure: the real
// adapter, scorer, report loader and sections, on a stand-in for Prisma.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Category } from '@prisma/client'
import type { ExtractedOpportunity, PrismaClient } from '@prisma/client'
import { EXTRACTION_SPEC_BY_CATEGORY } from '../../../../extraction/schemas'
import { opportunityToListingData } from '../../../../matching/adapters'
import { scorePair } from '../../../../matching/scorer'
import { reasonOf } from '../../../../matching/nightly/select'
import { plainFitReason, GENERIC_FIT_REASON } from '../../../../matching/fitReason'
import { makeBuyer, makeContext } from '../../../../matching/__tests__/fixtures'
import { gatherContext } from '../context'
import { curatedMatchesSection, HOMEOWNER_PRICE_LABEL } from '../sections/curated-matches'
import { nearMissesSection } from '../sections/near-misses'
import { generateBuyerMatchReport } from '../index'
import { installFakeAiFetch } from '../../../../__tests__/fakeAiFetch'

// No network: the Anthropic client is injected below, and the budget section's
// FRED lookup (made only when FRED_API_KEY is set) is refused by the stand-in.
installFakeAiFetch()

const ESTATE = 'Estate sale, the executor is handling it'
// What the model returns for the seller (V2 tool input).
const answer = {
  address: '12 Example St', neighborhood: 'Park Slope', borough: 'Brooklyn', city: 'Brooklyn', state: 'NY', zip: '11215',
  price: 1_900_000, beds: 4, baths: 2, squareFeet: 2400, units: 1, propertyType: 'townhouse', availabilityDate: null,
  status: 'Estate sale; the executor is handling it', sourceAgentName: 'Referring Agent', sourceAgentEmail: 'agent@example.com',
  sourceBrokerage: 'Example Realty', motivation: ESTATE,
  extractedTitle: 'Estate sale: Park Slope townhouse with a garden',
  extractedSummary: 'Owner wants to list the townhouse in the spring. Estate sale, the executor is handling it.',
  classificationReason: 'Seller lead: an estate sale the executor is handling.',
  confidenceScore: 0.9,
}
// The row as saved (Ryan's decision: the details are kept).
const saved = {
  ...answer,
  extractedSummary: `${answer.extractedSummary} Motivation: ${ESTATE}`,
}
// Never in buyer-facing text: the seller's circumstances, the seller's price
// or source, the referring agent.
const FORBIDDEN = /(?<!real )estate|executor|probate|inherit|divorc|passed|died|hospice|1,900,000|1\.9\s?m|\$1\.9|Example Realty|Referring Agent/i
// [Ryan, 2026-10-19]: nor the lead's street address.
const ADDRESS = /12 Example St|Example St/i

const spec = EXTRACTION_SPEC_BY_CATEGORY.SELLER_LEAD!
const mapped = spec.mapItem((spec.responseSchema.parse({ leads: [answer] }) as { leads: unknown[] }).leads[0], { subject: 's', senderName: null, senderEmail: null })

test('the seller lead is saved with its notes (the row the checks below use)', () => {
  assert.deepEqual(
    [mapped.extractedTitle, mapped.extractedSummary, mapped.classificationReason, mapped.status],
    [saved.extractedTitle, saved.extractedSummary, saved.classificationReason, saved.status],
  )
})

// The saved row as an ExtractedOpportunity (the columns the adapter reads).
const asOpp = (over: Record<string, unknown>) => ({
  id: 'lead-1', category: 'SELLER_LEAD', transactionType: 'SALE', propertyType: saved.propertyType, address: saved.address,
  neighborhood: saved.neighborhood, borough: saved.borough, price: saved.price, minPrice: null, maxPrice: null, beds: saved.beds,
  baths: saved.baths, units: saved.units, squareFeet: saved.squareFeet, mustHaves: null, monthlyMaintenance: null,
  monthlyCommonCharges: null, monthlyTaxes: null, yearBuilt: null, lotSizeSqft: null, zoningCode: null,
  extractedTitle: saved.extractedTitle, extractedSummary: saved.extractedSummary, classificationReason: saved.classificationReason,
  status: saved.status, sourceAgentName: saved.sourceAgentName, sourceBrokerage: saved.sourceBrokerage, availabilityDate: null,
  createdAt: new Date('2026-10-17T12:00:00Z'), ...over,
}) as unknown as ExtractedOpportunity

test('the fit line the scorer builds for that seller never names it', () => {
  const listing = opportunityToListingData(asOpp({}))
  const ctx = makeContext({ now: new Date('2026-10-17T12:00:00Z') })
  const buyers = [
    makeBuyer({ id: 'b1', neighborhoods: ['Park Slope'], priceMin: 1_500_000, priceMax: 2_000_000, bedsMin: 3, bedsMax: 5 }),
    makeBuyer({ id: 'b2', neighborhoods: ['Park Slope'], bedsMin: 4, mustHaves: 'outdoor space', propertyTypes: ['Townhouse'] }),
    makeBuyer({ id: 'b3', neighborhoods: ['Carroll Gardens'], priceMax: 1_200_000, bathsMin: 3, buyerArchetype: 'CASH_BUYER' }),
  ]
  let eligible = 0
  for (const b of buyers) {
    const r = scorePair(listing, b, ctx)
    if (!r.eligibility.eligible) continue
    eligible++
    const line = reasonOf(r.matchFit)
    for (const shown of [line, plainFitReason(line), plainFitReason(line, { homeowner: true })]) assert.doesNotMatch(shown, FORBIDDEN, shown)
  }
  assert.ok(eligible >= 2, 'the seller is scored against real buyers')
  // A stored reason in an older engine's words, carrying the lead's title, is never shown either.
  const older = `${saved.extractedTitle} may match ISO: Investor buyer (score 90)`
  assert.equal(plainFitReason(older), GENERIC_FIT_REASON)
  assert.equal(plainFitReason(older, { homeowner: true }), GENERIC_FIT_REASON)
})

// A buyer whose report lists old or odd Match rows with a seller lead, a
// landlord lead and a client conversation on the supply side, next to an
// ordinary listing.
const BUYER = {
  id: 'buyer-1', category: Category.BUYER_ISO, extractedTitle: 'Investor buyer', neighborhoods: ['Park Slope'], neighborhood: null,
  borough: 'Brooklyn', minBeds: 3, maxBeds: 5, beds: null, minPrice: 1_500_000, maxPrice: 2_000_000, price: null,
  mustHaves: null, dealbreakers: null, timeline: null, propertyTypes: [], isTestData: true, createdAt: new Date(),
}
const SUPPLY = [
  asOpp({ id: 'lead-addr' }),
  asOpp({ id: 'lead-no-addr', address: null }),
  asOpp({
    id: 'landlord-no-addr', category: 'LANDLORD_LEAD', address: null, neighborhood: 'Bushwick', price: 3200,
    extractedTitle: 'Landlord lead: owners divorcing, 2BR in Bushwick', extractedSummary: 'The owners are going through a divorce.',
  }),
  asOpp({
    id: 'conversation-no-addr', category: 'CLIENT_CONVERSATION', address: null, neighborhood: null, price: null,
    extractedTitle: 'Probate: the seller will list once probate closes', extractedSummary: 'Owner passed in March; heirs deciding.',
  }),
  asOpp({
    id: 'listing-1', category: 'ACTIVE_SALE_LISTING', address: null, price: 1_750_000, sourceBrokerage: 'Listing Brokerage',
    sourceAgentName: 'Listing Agent', extractedTitle: 'Renovated Park Slope 4BR', extractedSummary: 'Asking $1.75M.',
    classificationReason: 'Active listing.', status: 'Active',
  }),
]
const MATCHES = [
  { id: 'm1', tier: 'HOT', score: 92, reason: `${saved.extractedTitle} may match ISO: Investor buyer (score 92)`, opportunityId: 'lead-addr', opportunityType: 'opportunity' },
  { id: 'm2', tier: 'HOT', score: 90, reason: 'The executor wants a quick sale; fits the budget', opportunityId: 'lead-no-addr', opportunityType: 'opportunity' },
  { id: 'm3', tier: 'WARM', score: 72, reason: 'neighborhood + beds + price', opportunityId: 'landlord-no-addr', opportunityType: 'opportunity' },
  { id: 'm4', tier: 'POSSIBLE', score: 55, reason: 'Right neighborhood, bedroom count; weaker on price', opportunityId: 'conversation-no-addr', opportunityType: 'opportunity' },
  { id: 'm5', tier: 'HOT', score: 88, reason: 'In budget, right neighborhood', opportunityId: 'listing-1', opportunityType: 'opportunity' },
]
type FindMany = { where: { id?: { in: string[] }; category?: { in: string[] } } }
const prisma = {
  extractedOpportunity: {
    findUnique: async () => BUYER,
    findMany: async ({ where }: FindMany) => SUPPLY.filter(o =>
      (!where.id || where.id.in.includes(o.id)) && (!where.category || where.category.in.includes(o.category))),
  },
  mojoContact: { findMany: async () => [] },
  match: { findMany: async () => MATCHES },
} as unknown as PrismaClient

test('a Buyer Match report shows those rows exactly like a homeowner (area and type), with or without an address', async () => {
  const ctx = await gatherContext({ buyerId: BUYER.id, prisma })
  const curated = (await curatedMatchesSection(ctx)).content.items!
  const near = (await nearMissesSection(ctx)).content.items!
  const byId = new Map([...curated, ...near].map(i => [i.listingId, i]))
  const homeowner = (id: string, address: string, fitWas: string) => {
    const i = byId.get(id)!
    assert.equal(i.address, address, id)
    assert.deepEqual([i.price, i.priceLabel, i.source], [null, HOMEOWNER_PRICE_LABEL, 'off-market seller'], id)
    assert.equal(i.fit ?? i.why, plainFitReason(fitWas, { homeowner: true }), id)
  }
  homeowner('lead-addr', 'Townhouse in Park Slope', MATCHES[0].reason) // the lead's address is never shown
  homeowner('lead-no-addr', 'Townhouse in Park Slope', MATCHES[1].reason)
  homeowner('landlord-no-addr', 'Townhouse in Bushwick', MATCHES[2].reason)
  homeowner('conversation-no-addr', 'Townhouse in Brooklyn', MATCHES[3].reason) // no neighborhood: the borough
  assert.equal(byId.get('lead-no-addr')!.fit, GENERIC_FIT_REASON)
  assert.equal(byId.get('landlord-no-addr')!.why, 'Matched on neighborhood, bedrooms') // never price for a homeowner
  // An ordinary listing is shown as before: its title when there's no address, its price and source.
  assert.deepEqual(
    [byId.get('listing-1')!.address, byId.get('listing-1')!.priceLabel, byId.get('listing-1')!.source, byId.get('listing-1')!.fit],
    ['Renovated Park Slope 4BR', '$1,750,000', 'Listing Brokerage', 'In budget, right neighborhood'],
  )
})

test('the whole report (every section, the markdown, the AI-written recommendation) never names them', async () => {
  const sent: string[] = []
  const anthropic = {
    messages: { create: async (req: unknown) => { sent.push(JSON.stringify(req)); return { content: [{ type: 'text', text: 'Widen the budget slightly.' }] } } },
  }
  const report = await generateBuyerMatchReport({ buyerId: BUYER.id, prisma, anthropic: anthropic as never })
  assert.equal(report.sections.length, 8)
  assert.equal(report.matchCount, 3)
  for (const re of [FORBIDDEN, ADDRESS]) {
    assert.doesNotMatch(report.markdown, re)
    assert.doesNotMatch(JSON.stringify(report.sections), re)
  }
  assert.equal(sent.length, 1)
  assert.doesNotMatch(sent[0], FORBIDDEN)
  assert.doesNotMatch(sent[0], ADDRESS)
  assert.match(report.markdown, /Townhouse in Park Slope \(price on request\)/)
  // Price per square foot comes from the ordinary listing alone ($1.75M / 2,400 SF).
  const budget = report.sections.find(s => s.key === 'budget-reality')!
  assert.equal(budget.content.metrics![0].value, '$729')
  assert.match(budget.content.prose!, /mortgage rate is unavailable/) // no FRED lookup reached the network
})

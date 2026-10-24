// Brief 43 PR 3b: no street address in a note to a buyer or a buyer's agent
// [Ryan, 2026-10-19]. Until the homeowner has agreed to sell, a CRM homeowner's
// home is described by area and type ("3-family in Bedford-Stuyvesant") and its
// price reads "price on request". The only sign of "agreed to sell" today is the
// CRM's ryan_listing tag (Ryan's own listing). Listings from emails or
// StreetEasy keep their addresses: they're public. Pure: the real resolver,
// draft prompt, report loader and sections, on a stand-in for Prisma; the
// model is a stand-in too, and any other network call is refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Category } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { installFakeAiFetch } from './fakeAiFetch'
import { resolveSupply } from '../matching/supplyResolver'
import { buyerFacingSupply, homeAreaAndType } from '../buyerFacingSupply'
import { draftOutreachSystemPrompt } from '../matching/draftPrompt'
import { generateBuyerMatchReport } from '../reports/generators/buyer-match'

installFakeAiFetch()

// Fictional people and addresses only.
const HOMEOWNER = {
  id: 'mc-1', fullName: 'Pat Example', address: '88 Example Ave', neighborhood: 'Bedford-Stuyvesant',
  propertyBeds: 6, buildingSqft: 3300, priorListingBrokerage: null, propertyTypeDetail: 'Triplex', unitCount: 3,
  tags: ['seller'], isTestData: true,
}
const SECOND_HOMEOWNER = {
  ...HOMEOWNER, id: 'mc-3', fullName: 'Casey Example', address: '188 Example Ave', neighborhood: 'Bushwick',
  propertyTypeDetail: 'Two Family Dwelling', unitCount: 2,
}
const RYAN_LISTING = {
  ...HOMEOWNER, id: 'mc-2', fullName: 'Jordan Sample', address: '12 Sample St', neighborhood: 'Park Slope',
  propertyTypeDetail: 'Townhouse', unitCount: 1, tags: ['seller', 'ryan_listing'],
}
const EMAIL_LISTING = {
  id: 'eo-1', category: 'ACTIVE_SALE_LISTING', address: '40 Example Pl', neighborhood: 'Bedford-Stuyvesant', borough: 'Brooklyn',
  price: 1_650_000, minPrice: null, maxPrice: null, beds: 3, squareFeet: 2000, extractedTitle: 'Renovated 3BR',
  sourceBrokerage: 'Listing Brokerage', sourceAgentName: 'Listing Agent', availabilityDate: null, propertyType: 'Townhouse', units: 2,
  isTestData: true,
}
const OFF_MARKET_EMAIL = { ...EMAIL_LISTING, id: 'eo-2', category: 'OFF_MARKET_SALE', address: '9 Sample Ct', price: 1_400_000 }
const BUYER = {
  id: 'b1', category: Category.BUYER_ISO, extractedTitle: 'Investor buyer', neighborhoods: ['Bedford-Stuyvesant', 'Park Slope'],
  neighborhood: null, borough: 'Brooklyn', minBeds: 3, maxBeds: 6, beds: null, minPrice: 1_500_000, maxPrice: 2_500_000, price: null,
  mustHaves: null, dealbreakers: null, timeline: null, propertyTypes: [], isTestData: true, createdAt: new Date(),
}
const MATCHES = [
  { id: 'm1', tier: 'HOT', score: 91, reason: 'Right neighborhood, bedroom count', opportunityId: 'mc-1', opportunityType: 'contact' },
  { id: 'm2', tier: 'HOT', score: 89, reason: 'Right neighborhood', opportunityId: 'mc-2', opportunityType: 'contact' },
  { id: 'm3', tier: 'HOT', score: 87, reason: 'In budget, right neighborhood', opportunityId: 'eo-1', opportunityType: 'opportunity' },
  { id: 'm4', tier: 'WARM', score: 70, reason: 'neighborhood + beds', opportunityId: 'mc-3', opportunityType: 'contact' },
]
type Where = { id?: { in: string[] }; category?: { in: string[] } }
const prisma = {
  extractedOpportunity: {
    findUnique: async () => BUYER,
    findMany: async ({ where }: { where: Where }) => [EMAIL_LISTING, OFF_MARKET_EMAIL].filter(o =>
      (!where.id || where.id.in.includes(o.id)) && (!where.category || where.category.in.includes(o.category))),
  },
  mojoContact: {
    findMany: async ({ where }: { where: Where }) => [HOMEOWNER, SECOND_HOMEOWNER, RYAN_LISTING].filter(c => where.id?.in.includes(c.id)),
  },
  match: { findMany: async () => MATCHES },
  matchDismissal: { findMany: async () => [] }, // Brief 48 PR 13 (M29): the report leaves dismissed matches out
} as unknown as PrismaClient

// The untagged homeowners' streets ("88 Example Ave", "188 Example Ave"), and
// the house number on its own.
const STREET = /Example Ave/i
const HOUSE_NUMBER = /\b1?88\b/
const PARTY = { name: 'Buyer Agent', role: 'buyer ISO', budget: '$1.5M–$2.5M', beds: '3–6BR', neighborhood: 'Bedford-Stuyvesant' }
const promptFor = (supply: Parameters<typeof draftOutreachSystemPrompt>[0]['supply']) =>
  draftOutreachSystemPrompt({ channel: 'email', party: PARTY, supply, matchReason: 'Right neighborhood, bedroom count' })

test('a homeowner is described by area and type', () => {
  const at = (propertyTypeText: string | null, unitCount: number | null, neighborhood: string | null = 'Park Slope', borough: string | null = 'Brooklyn') =>
    homeAreaAndType({ propertyTypeText, unitCount, neighborhood, borough })
  assert.equal(at('Triplex', 3, 'Bedford-Stuyvesant'), '3-family in Bedford-Stuyvesant')
  assert.equal(at('Two Family Dwelling', 2), '2-family in Park Slope')
  assert.equal(at('Apartment House (5+ Units)', 8), '8-unit building in Park Slope')
  assert.equal(at('Multi-Family Dwelling', null), 'Multi-family in Park Slope')
  assert.equal(at('Townhouse', 1), 'Townhouse in Park Slope')
  assert.equal(at('SFH', 1), 'Single-family home in Park Slope')
  assert.equal(at('Condo', 40), 'Condo in Park Slope') // a condo's unit count is the building's
  assert.equal(at('Co-op', null), 'Co-op in Park Slope')
  assert.equal(at('Mixed-Use Multi-Family', 4), 'Mixed-use building in Park Slope')
  assert.equal(at(null, null), 'Home in Park Slope')
  assert.equal(at(null, null, null), 'Home in Brooklyn')
  assert.equal(at(null, null, '  ', null), 'Home')
})

test('a CRM homeowner without the ryan_listing tag: no house number or street in the supply line or the draft prompt', async () => {
  const found = await resolveSupply(prisma, 'mc-1', 'contact')
  assert.ok(found)
  assert.equal(found.address, '88 Example Ave') // Ryan's own screens still show it
  const shown = buyerFacingSupply(found)
  assert.equal(shown.address, null)
  assert.equal(shown.extractedTitle, '3-family in Bedford-Stuyvesant')
  assert.equal(shown.opportunityType, 'contact')
  for (const [label, prompt] of [['shown', promptFor(shown)], ['raw', promptFor(found)]] as const) {
    assert.match(prompt, /Property: 3-family in Bedford-Stuyvesant · 6BR · price on request/, label)
    assert.doesNotMatch(prompt, STREET, label)
    assert.doesNotMatch(prompt, HOUSE_NUMBER, label)
    assert.doesNotMatch(prompt, /Include address/i, label)
    assert.match(prompt, /no street address/i, label)
  }
})

test("with the ryan_listing tag (Ryan's own listing, so the homeowner has agreed to sell): the address is allowed", async () => {
  const found = await resolveSupply(prisma, 'mc-2', 'contact')
  assert.ok(found)
  const shown = buyerFacingSupply(found)
  assert.equal(shown.address, '12 Sample St')
  const prompt = promptFor(shown)
  assert.match(prompt, /Property: 12 Sample St · 6BR · price on request/) // still never our estimate
  assert.match(prompt, /Include address/)
})

test('an email listing keeps its address and its asking price', async () => {
  const found = await resolveSupply(prisma, 'eo-1', 'opportunity')
  assert.ok(found)
  assert.deepEqual(buyerFacingSupply(found), found)
  const prompt = promptFor(found)
  assert.match(prompt, /Property: 40 Example Pl · 3BR · \$1\.65M/)
  assert.match(prompt, /Include address/)
})

test('the whole Buyer Match report: no street for an untagged homeowner; the tagged one and email listings keep theirs', async () => {
  const sent: string[] = []
  const anthropic = {
    messages: { create: async (req: unknown) => { sent.push(JSON.stringify(req)); return { content: [{ type: 'text', text: 'The criteria are working.' }] } } },
  }
  const report = await generateBuyerMatchReport({ buyerId: 'b1', prisma, anthropic: anthropic as never })
  assert.equal(sent.length, 1)
  for (const [label, text] of [['markdown', report.markdown], ['sections', JSON.stringify(report.sections)], ['recommendation prompt', sent[0]]]) {
    assert.doesNotMatch(text, STREET, label)
  }
  assert.doesNotMatch(report.markdown, HOUSE_NUMBER)

  const items = (key: string) => report.sections.find(s => s.key === key)!.content.items!
  const row = (key: string, id: string) => items(key).find(i => i.listingId === id)!
  assert.deepEqual([row('curated-matches', 'mc-1').address, row('curated-matches', 'mc-1').priceLabel], ['3-family in Bedford-Stuyvesant', 'price on request'])
  assert.deepEqual([row('near-misses', 'mc-3').address, row('near-misses', 'mc-3').priceLabel], ['2-family in Bushwick', 'price on request'])
  assert.deepEqual([row('curated-matches', 'mc-2').address, row('curated-matches', 'mc-2').priceLabel], ['12 Sample St', 'price on request'])
  assert.deepEqual([row('curated-matches', 'eo-1').address, row('curated-matches', 'eo-1').priceLabel], ['40 Example Pl', '$1,650,000'])
  assert.equal(row('off-market', 'eo-2').address, '9 Sample Ct')

  assert.match(report.markdown, /3-family in Bedford-Stuyvesant \(price on request\)/)
  assert.match(report.markdown, /2-family in Bushwick \(price on request;/)
  assert.match(report.markdown, /12 Sample St \(price on request\)/)
  assert.match(report.markdown, /40 Example Pl at \$1,650,000/)
  assert.match(report.markdown, /9 Sample Ct/)
})

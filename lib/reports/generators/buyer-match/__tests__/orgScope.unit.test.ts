// Brief 48 PR 13 (Q44): DealFlow has one organization today, but every read
// behind a Buyer Match report is scoped to one: the buyer (another
// organization's id is "not found"), its matches, and the off-market leads.
// With no organization given (Drift's report tool, whose buyer ids come from
// organization-scoped searches), the buyer's own organization is used.
// Pure: the real loader and sections on a stand-in for Prisma that evaluates
// every filter (pr13FakePrisma.ts); no database. Made-up places only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import { makeFakePrisma, emailBuyer, emailListing, listingMatch, contact, ORG } from '../../../__tests__/pr13FakePrisma'
import { gatherContext } from '../context'
import { offMarketSection } from '../sections/off-market'

const OTHER = 'org_other'
const buyer = emailBuyer({ id: 'buyer_q44', neighborhoods: ['Park Slope'] })
const ours = emailListing({ id: 'ours', address: '50 Sample St' })
const theirs = emailListing({ id: 'theirs', address: '51 Sample St', organizationId: OTHER })
const offOurs = emailListing({ id: 'off_ours', category: 'OFF_MARKET_SALE', address: '52 Sample St', neighborhood: 'Park Slope' })
const offTheirs = emailListing({ id: 'off_theirs', category: 'OFF_MARKET_SALE', address: '53 Sample St', neighborhood: 'Park Slope', organizationId: OTHER })

// Review r1: another organization's rows that aren't buyers either.
const theirLead = emailListing({ id: 'their_lead', category: 'SELLER_LEAD', organizationId: OTHER })
const theirSeller = contact({ id: 'their_seller', intent: 'SELLER', organizationId: OTHER })

const fake = makeFakePrisma({
  extractedOpportunity: [buyer, ours, theirs, offOurs, offTheirs, theirLead],
  mojoContact: [theirSeller],
  match: [
    listingMatch('ours', 'buyer_q44', { tier: 'HOT' }),
    // A row in another organization naming the same buyer id.
    listingMatch('theirs', 'buyer_q44', { tier: 'HOT', organizationId: OTHER }),
  ],
  matchDismissal: [],
})
const prisma = fake.prisma as unknown as PrismaClient

test("another organization's buyer id is not found", async () => {
  await assert.rejects(gatherContext({ buyerId: 'buyer_q44', prisma, organizationId: OTHER }), /not found/)
})

test("another organization's id is \"not found\" before anything else is said about it (review r1)", async () => {
  for (const id of ['their_lead', 'their_seller']) {
    await assert.rejects(gatherContext({ buyerId: id, prisma, organizationId: ORG }), (e: Error) => {
      assert.equal(e.message, `buyer-match: buyer ${id} not found`)
      return true
    })
  }
})

test("the report reads only its organization's matches and off-market leads", async () => {
  for (const organizationId of [ORG, undefined]) {
    const ctx = await gatherContext({ buyerId: 'buyer_q44', prisma, organizationId })
    assert.deepEqual((await ctx.matches()).map(m => m.listing.id), ['ours'], String(organizationId))
    const off = await offMarketSection(ctx)
    assert.deepEqual((off.content.items ?? []).map(i => i.listingId), ['off_ours'], String(organizationId))
  }
})

// Brief 32 Part A — integration test: a MojoContact SELLER × BUYER_ISO match is
// persisted with opportunityType='contact' AND the report engine renders it
// correctly (resolveSupplies resolves the contact supply through the dropped-FK
// reader path). Requires the Brief 32 seed + regen to have run. Run via tsx (this
// file transitively imports the @/-free report context but hits the live DB).
import 'dotenv/config'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '@/lib/prisma'
import { gatherContext } from '@/lib/reports/generators/buyer-match/context'

test('contact-supply match is persisted with opportunityType=contact and renders in the report', async () => {
  // Find a persisted contact-supply match whose demand side is a BUYER_ISO opp
  // (counterpartType='opportunity' is what the report's matches() loader queries).
  const match = await prisma.match.findFirst({
    where: { opportunityType: 'contact', counterpartType: 'opportunity' },
    select: { opportunityId: true, counterpartId: true, opportunityType: true, score: true },
  })
  assert.ok(match, 'expected at least one opportunityType=contact match — did the Brief 32 regen run?')
  assert.equal(match.opportunityType, 'contact')

  // The supply id must resolve to a real MojoContact SELLER (not an EO).
  const seller = await prisma.mojoContact.findUnique({ where: { id: match.opportunityId }, select: { fullName: true, intent: true } })
  assert.ok(seller, 'contact-supply opportunityId must reference a MojoContact')
  assert.equal(seller.intent, 'SELLER')

  // The report engine must render this match without the (now-removed) FK relation.
  const ctx = await gatherContext({ buyerId: match.counterpartId, prisma })
  const listings = await ctx.matches()
  const rendered = listings.find(l => l.listing.id === match.opportunityId)
  assert.ok(rendered, 'contact supply should appear in the buyer-match report listings')
  assert.equal(rendered.listing.category, null, 'contact supply has no email Category')
  assert.equal(rendered.listing.extractedTitle, seller.fullName, 'contact supply title = seller name')

  await prisma.$disconnect()
})

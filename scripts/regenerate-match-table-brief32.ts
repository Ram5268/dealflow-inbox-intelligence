// Brief 32 Part A — regenerate seed Match rows using the new logit-space scorer.
//
// Directional by construction: opportunityId = LISTING (supply), counterpartId =
// BUYER (demand). opportunityType = 'contact' when the supply is a MojoContact
// SELLER, else 'opportunity'. counterpartType = 'mojo' for MojoContact buyers,
// 'opportunity' for BUYER_ISO opportunities. Only listing-side rows drive the
// outer loop, so there is no directional double-file.
//
// Run:  npx tsx scripts/regenerate-match-table-brief32.ts
import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { ensureConnected, getOrgAndAnchor } from './seed-stress-common'
import {
  opportunityToListingData, mojoContactToListingData,
  opportunityToBuyerData, mojoContactToBuyerData,
} from '../lib/matching/adapters'
import { scorePair } from '../lib/matching/scorer'
import { precomputeCompsMedians, precomputeSubstitutionCounts } from '../lib/matching/compsCache'
import type { ListingData, BuyerData } from '../lib/matching/scorerTypes'
import type { Prisma } from '@prisma/client'

const SALE_LISTING_CATS = ['COMING_SOON_SALE', 'OFF_MARKET_SALE', 'ACTIVE_SALE_LISTING', 'PRICE_DROP', 'BACK_ON_MARKET', 'DEVELOPMENT_INVENTORY', 'SPONSOR_UNIT', 'COMING_SOON_DEVELOPMENT']

function tierOf(mf: number): 'HOT' | 'WARM' | 'POSSIBLE' {
  return mf >= 80 ? 'HOT' : mf >= 65 ? 'WARM' : 'POSSIBLE'
}
function reasonOf(contributions: Record<string, number>): string {
  return Object.entries(contributions).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k).join(' + ')
}
async function chunked<T>(arr: T[], size: number, fn: (slice: T[]) => Promise<void>) {
  for (let i = 0; i < arr.length; i += size) await fn(arr.slice(i, i + size))
}

async function main() {
  const t0 = Date.now()
  await ensureConnected()
  const { orgId } = await getOrgAndAnchor()

  // ── Fetch buyers (demand) ──────────────────────────────────────────────────
  const mojoBuyers = await prisma.mojoContact.findMany({
    where: { organizationId: orgId, isTestData: true, intent: 'BUYER' },
  })
  const oppBuyers = await prisma.extractedOpportunity.findMany({
    where: {
      organizationId: orgId, isTestData: true, category: 'BUYER_ISO',
      OR: [{ extractedTitle: { startsWith: '[TEST_10] ' } }, { extractedTitle: { startsWith: '[TEST_32] ' } }],
    },
  })
  const buyers: BuyerData[] = [...mojoBuyers.map(mojoContactToBuyerData), ...oppBuyers.map(opportunityToBuyerData)]

  // ── Fetch listings (supply) ────────────────────────────────────────────────
  const sellerContacts = await prisma.mojoContact.findMany({
    where: { organizationId: orgId, isTestData: true, intent: 'SELLER' },
  })
  const listingOpps = await prisma.extractedOpportunity.findMany({
    where: {
      organizationId: orgId, isTestData: true, transactionType: 'SALE',
      category: { in: SALE_LISTING_CATS as never },
      OR: [{ extractedTitle: { startsWith: '[TEST_10] ' } }, { extractedTitle: { startsWith: '[TEST_25] ' } }],
    },
  })
  const listings: ListingData[] = [...sellerContacts.map(mojoContactToListingData), ...listingOpps.map(opportunityToListingData)]

  console.log(`Buyers: ${buyers.length} (${mojoBuyers.length} mojo + ${oppBuyers.length} ISO). Listings: ${listings.length} (${sellerContacts.length} seller-contacts + ${listingOpps.length} EO).`)

  // ── Representation posture (capture probability) ────────────────────────────
  const ryanOwnedListingIds = new Set(sellerContacts.filter(c => c.tags.includes('ryan_listing')).map(c => c.id))
  // Deterministically mark ~15% of mojo buyers as Ryan-represented + persist a tag.
  const repBuyers = mojoBuyers.filter((_, i) => i % 7 === 0)
  for (const b of repBuyers) {
    if (!b.tags.includes('ryan_buyer')) {
      await prisma.mojoContact.update({ where: { id: b.id }, data: { tags: { set: [...b.tags, 'ryan_buyer'] } } })
    }
  }
  const ryanRepresentedBuyerIds = new Set(repBuyers.map(b => b.id))

  // ── Pre-compute context ─────────────────────────────────────────────────────
  const compsCtx = await precomputeCompsMedians(prisma, orgId)
  const substitutionCounts = precomputeSubstitutionCounts(buyers, listings)
  const ctx = {
    now: new Date(),
    compsMedians: compsCtx.medians,
    substitutionCounts,
    ryanOwnedListingIds,
    ryanRepresentedBuyerIds,
  }

  // ── Delete existing seed Match rows (both directions) ───────────────────────
  const allSeedIds = [...new Set([...listings.map(l => l.id), ...buyers.map(b => b.id)])]
  let deleted = 0
  await chunked(allSeedIds, 500, async (slice) => {
    const r = await prisma.match.deleteMany({
      where: { organizationId: orgId, OR: [{ opportunityId: { in: slice } }, { counterpartId: { in: slice } }] },
    })
    deleted += r.count
  })
  console.log(`Deleted ${deleted} existing seed Match rows.`)

  // ── Score every (listing × buyer) pair ──────────────────────────────────────
  let pairs = 0, eligible = 0, scored = 0, filtered = 0
  const rows: Prisma.MatchCreateManyInput[] = []
  for (const listing of listings) {
    for (const buyer of buyers) {
      pairs++
      const res = scorePair(listing, buyer, ctx)
      if (!res.eligibility.eligible) continue
      eligible++
      const mf = res.matchFit.matchFit
      if (mf < 30) { filtered++; continue }
      scored++
      rows.push({
        organizationId: orgId,
        opportunityId: listing.id,
        opportunityType: listing.sourceType === 'contact' ? 'contact' : 'opportunity',
        counterpartId: buyer.id,
        counterpartType: buyer.sourceType === 'contact' ? 'mojo' : 'opportunity',
        score: mf,
        tier: tierOf(mf),
        reason: reasonOf(res.matchFit.contributions),
        captureProbability: res.captureProbability,
        expectedGrossCompensation: res.expectedGrossCompensation,
        contributions: res.matchFit.contributions as Prisma.InputJsonValue,
        unknownFactors: res.matchFit.unknownFactors,
      })
    }
  }

  // ── Bulk insert ─────────────────────────────────────────────────────────────
  let inserted = 0
  await chunked(rows, 500, async (slice) => {
    const r = await prisma.match.createMany({ data: slice, skipDuplicates: true })
    inserted += r.count
  })

  // ── Report ──────────────────────────────────────────────────────────────────
  const tierCounts = { HOT: 0, WARM: 0, POSSIBLE: 0 }
  let mfSum = 0, ukSum = 0
  for (const r of rows) { tierCounts[r.tier as 'HOT' | 'WARM' | 'POSSIBLE']++; mfSum += r.score; ukSum += (r.unknownFactors as string[]).length }
  const opportunityTypeContact = rows.filter(r => r.opportunityType === 'contact').length

  console.log('\n════════ Brief 32 regen report ════════')
  console.log(`Pairs evaluated:     ${pairs}`)
  console.log(`  eligible:          ${eligible}`)
  console.log(`  scored (mf>=30):   ${scored}`)
  console.log(`  filtered (<30):    ${filtered}`)
  console.log(`Match rows written:  ${inserted}`)
  console.log(`  opportunityType=contact (seller-supply): ${opportunityTypeContact}`)
  console.log(`  opportunityType=opportunity (EO-supply): ${inserted - opportunityTypeContact}`)
  console.log(`Tier distribution:   HOT ${tierCounts.HOT} / WARM ${tierCounts.WARM} / POSSIBLE ${tierCounts.POSSIBLE}`)
  console.log(`Average matchFit:    ${(mfSum / (rows.length || 1)).toFixed(1)}`)
  console.log(`Avg unknownFactors:  ${(ukSum / (rows.length || 1)).toFixed(2)}`)
  console.log(`Elapsed:             ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })

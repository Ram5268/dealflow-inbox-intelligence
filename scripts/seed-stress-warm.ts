// Brief 10.0 — re-warm helper. Runs the REAL matching engine over the deliberate
// [TEST_10] supply listings and persists Match rows (HOT/WARM/POSSIBLE), plus the
// showing-confirmation self-matches. Idempotent (upserts), so it safely RESUMES a
// paused/partial seed or re-warms after dismissals without re-seeding data.
//
// "Deliberate" targets = the fresh (<5-day) [TEST_10] SUPPLY listings the pair
// constructor made in Part C; bulk listings are spread across 30 days, so the
// freshness cutoff selects the pairs without depending on titles.
//
// Run:  npx tsx scripts/seed-stress-warm.ts
import 'dotenv/config' // MUST be first — see seed-stress-inbox-opps.ts note.
import { Category, MatchTier } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { findMatchesForListing } from '../lib/matching/engine'
import { MatchingCostAbort } from '../lib/matching/cost'
import { SUPPLY_SALE, SUPPLY_RENTAL } from '../lib/domain/Categories'
import { TAG, ORG_SLUG, ensureConnected, retryDb } from './seed-stress-common'

process.env.MATCHING_MAX_CANDIDATES ??= '8'
const WARM_BUDGET_USD = 2.0
const WARM_WALLCLOCK_MS = 6 * 60_000
const FRESH_DAYS = 5

const TIER_SCORE: Record<'Hot' | 'Warm' | 'Possible', number> = { Hot: 90, Warm: 70, Possible: 50 }
const TIER_ENUM: Record<'Hot' | 'Warm' | 'Possible', MatchTier> = { Hot: MatchTier.HOT, Warm: MatchTier.WARM, Possible: MatchTier.POSSIBLE }

async function main() {
  await ensureConnected()
  const org = await prisma.organization.findUnique({ where: { slug: ORG_SLUG }, select: { id: true } })
  if (!org) throw new Error(`Org "${ORG_SLUG}" not found.`)
  const orgId = org.id
  const since = new Date(Date.now() - FRESH_DAYS * 86_400_000)

  // Showing-confirmation self-matches first (cheap, no LLM) — idempotent.
  const showings = await prisma.extractedOpportunity.findMany({
    where: { organizationId: orgId, isTestData: true, category: Category.SHOWING_CONFIRMATION, extractedTitle: { startsWith: `${TAG} ` }, createdAt: { gte: since } },
    select: { id: true, extractedTitle: true, address: true, availabilityDate: true },
  })
  for (const s of showings) {
    const reason = `Showing confirmation: ${s.extractedTitle}${s.address ? ' at ' + s.address : ''}${s.availabilityDate ? ' on ' + s.availabilityDate : ''}. Add to your Outlook calendar?`
    await retryDb(() => prisma.match.upsert({
      where: { opportunityId_counterpartId_counterpartType: { opportunityId: s.id, counterpartId: s.id, counterpartType: 'showing_confirmation' } },
      create: { organizationId: orgId, opportunityId: s.id, counterpartId: s.id, counterpartType: 'showing_confirmation', score: 90, reason },
      update: { score: 90, reason },
    }))
  }
  console.log(`Showing self-matches: ${showings.length}`)

  // Fresh [TEST_10] supply listings = the deliberate pair listings. Priority:
  // SE-tagged titles → HOT "Coming Soon" pairs → everything else (near/adjacent).
  const listings = await prisma.extractedOpportunity.findMany({
    where: {
      organizationId: orgId, isTestData: true, extractedTitle: { startsWith: `${TAG} ` },
      category: { in: [...SUPPLY_SALE, ...SUPPLY_RENTAL] }, createdAt: { gte: since },
    },
    select: { id: true, extractedTitle: true, createdAt: true },
  })
  const priority = (t: string) => /\(SE match\)/.test(t) ? 0 : /Coming Soon/.test(t) ? 1 : 2
  listings.sort((a, b) => priority(a.extractedTitle) - priority(b.extractedTitle) || b.createdAt.getTime() - a.createdAt.getTime())
  console.log(`Warm targets (fresh supply listings): ${listings.length}`)

  let spend = 0, written = 0
  const tierCounts: Record<string, number> = { HOT: 0, WARM: 0, POSSIBLE: 0 }
  const start = Date.now()
  for (const l of listings) {
    if (spend >= WARM_BUDGET_USD) { console.log(`  ⛔ $ budget reached (spent $${spend.toFixed(4)}).`); break }
    if (Date.now() - start > WARM_WALLCLOCK_MS) { console.log('  ⛔ wall-clock cap reached.'); break }
    try {
      const res = await retryDb(() => findMatchesForListing(l.id, { limit: 25 }))
      spend += res.costUSD
      for (const m of res.results) {
        await retryDb(() => prisma.match.upsert({
          where: { opportunityId_counterpartId_counterpartType: { opportunityId: l.id, counterpartId: m.party.id, counterpartType: 'opportunity' } },
          create: { organizationId: orgId, opportunityId: l.id, counterpartId: m.party.id, counterpartType: 'opportunity', score: TIER_SCORE[m.tier], tier: TIER_ENUM[m.tier], reason: m.reason },
          update: { score: TIER_SCORE[m.tier], tier: TIER_ENUM[m.tier], reason: m.reason },
        }))
        written++; tierCounts[m.tier.toUpperCase()]++
      }
      const short = l.extractedTitle.replace(`${TAG} `, '').slice(0, 34)
      console.log(`  ✓ ${short.padEnd(36)} ${res.results.length} match(es)  Σ$${spend.toFixed(4)}`)
    } catch (e) {
      if (e instanceof MatchingCostAbort) { spend = e.runningCostUsd; console.log(`  ⚠︎ cost kill-switch — ${e.message}`); break }
      console.log(`  ⚠︎ ${l.id}: ${(e as Error).message}`)
    }
  }

  console.log('\n' + '═'.repeat(56))
  console.log(`MATCHES WRITTEN:   ${written + showings.length} (HOT ${tierCounts.HOT} · WARM ${tierCounts.WARM} · POSSIBLE ${tierCounts.POSSIBLE} · showings ${showings.length})`)
  console.log(`WARM SONNET SPEND: $${spend.toFixed(4)}`)
  console.log('═'.repeat(56))
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })

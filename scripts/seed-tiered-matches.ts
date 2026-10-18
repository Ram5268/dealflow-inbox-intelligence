// Brief 7.1 — TEST-MODE-ONLY demo-data seeder for the tiered Matches UI.
//
// Populates persistent Match rows (with the new Match.tier column) so the /matches
// page can demo tier chips + the SE Expert badge + dismiss. It reads the Brief 7.0
// fixtures (test/fixtures/matches/*.json), and for EACH fixture: seeds its listing
// + parties into a DEDICATED throwaway org, runs the REAL matching engine
// (findMatchesForListing), and writes the resulting party↔listing pairs back as
// Match rows with tier populated. partyPriority is DERIVED at read time from the
// party's source (see app/api/matches/route.ts) — it is not stored.
//
// Isolation: one org per fixture (slug `matching-demo-<id>`). The engine scopes
// candidate queries by organizationId, so a fixture's listing only ever matches
// its OWN seeded parties — no cross-fixture contamination, no cost blowup. Unlike
// the fixture harness, rows are LEFT IN PLACE so the UI can render them.
//
// Safety: refuses to run unless MATCHING_TEST_MODE_ONLY=true. All rows are
// isTestData=true and live under `matching-demo-*` orgs so they can be purged.
//
// Usage:
//   MATCHING_TEST_MODE_ONLY=true npx tsx scripts/seed-tiered-matches.ts [--run-cap <usd>] [--purge]
import 'dotenv/config'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { Category, MatchTier, TransactionType } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { SUPPLY_RENTAL } from '../lib/domain/Categories'
import { findMatchesForListing } from '../lib/matching/engine'
import { MatchingCostAbort } from '../lib/matching/cost'
import { isMatchingTestModeOnly } from '../lib/config/matchingTestMode'
import type { SourceBadge, Tier } from '../lib/matching/types'
import { refuseLiveDatabase } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): test or seed data only, so it refuses
// any database but a *_perf or *_test one, with no override.
refuseLiveDatabase(process.env.DATABASE_URL, 'scripts/seed-tiered-matches.ts (DATABASE_URL)')

const FIXTURE_ROOT = join(process.cwd(), 'test', 'fixtures', 'matches')
const RENTAL_CATS = new Set<Category>(SUPPLY_RENTAL)

const argv = process.argv.slice(2)
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const RUN_CAP_USD = flag('--run-cap') ? parseFloat(flag('--run-cap')!) : 0.5
const PURGE_ONLY = argv.includes('--purge')

// ── Fixture types (mirror scripts/matching-fixture-harness.ts) ────────────────
interface PartyFixture {
  role: 'buyer' | 'renter'
  source: SourceBadge
  name: string
  budgetMin?: number | null
  budgetMax?: number | null
  neighborhoods?: string[]
  borough?: string | null
  bedsMin?: number | null
  bedsMax?: number | null
  cashOnly?: boolean
  timing?: string | null
  createdDaysAgo: number
}
interface ListingFixture {
  category: string
  address?: string | null
  neighborhood?: string | null
  borough?: string | null
  beds?: number | null
  price?: number | null
  createdDaysAgo: number
}
interface MatchFixture {
  id: string
  kind: 'tier' | 'ranking'
  party?: PartyFixture
  parties?: PartyFixture[]
  listing: ListingFixture
}

function loadFixtures(): MatchFixture[] {
  const out: MatchFixture[] = []
  for (const f of readdirSync(FIXTURE_ROOT).filter(x => x.endsWith('.json') && x !== 'last-run-report.json')) {
    const arr = JSON.parse(readFileSync(join(FIXTURE_ROOT, f), 'utf8')) as MatchFixture[]
    out.push(...arr)
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

// ── Seed helpers ──────────────────────────────────────────────────────────────
function daysAgoDate(n: number): Date { return new Date(Date.now() - n * 86_400_000) }
function brokerageFor(source: SourceBadge): string {
  return source === 'streeteasy_expert' ? 'StreetEasy Experts' : source === 'mojo' ? 'Mojo' : 'Elliman Inbox'
}
function orgSlugFor(fixtureId: string): string {
  return `matching-demo-${fixtureId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

// tier + source → a legacy 0–100 score for the existing "SCORE N" badge. Tier is
// the new primary signal; score is kept so legacy UI (tabs, sort) still works.
const TIER_DB: Record<Exclude<Tier, 'None'>, MatchTier> = { Hot: 'HOT', Warm: 'WARM', Possible: 'POSSIBLE' }
function tierToScore(tier: Exclude<Tier, 'None'>, source: SourceBadge): number {
  const base = tier === 'Hot' ? 88 : tier === 'Warm' ? 74 : 58
  const bump = source === 'streeteasy_expert' ? 6 : source === 'mojo' ? 3 : 0
  return Math.min(99, base + bump)
}

async function ensureOrgAndEmail(slug: string): Promise<{ orgId: string; rawEmailId: string }> {
  const org = await prisma.organization.upsert({
    where: { slug },
    update: {},
    create: { name: `Matching Demo (${slug})`, slug },
    select: { id: true },
  })
  const emailKey = `matching-demo-email-${slug}`
  const email = await prisma.rawEmail.upsert({
    where: { graphMessageId: emailKey },
    update: {},
    create: { graphMessageId: emailKey, subject: 'Matching demo placeholder', receivedDateTime: new Date(), organizationId: org.id },
    select: { id: true },
  })
  return { orgId: org.id, rawEmailId: email.id }
}

// Wipe a demo org's prior opps/matches/dismissals so re-running is idempotent.
async function wipeOrg(orgId: string): Promise<void> {
  const opps = await prisma.extractedOpportunity.findMany({ where: { organizationId: orgId }, select: { id: true } })
  const ids = opps.map(o => o.id)
  await prisma.match.deleteMany({ where: { organizationId: orgId } })
  if (ids.length) {
    await prisma.matchDismissal.deleteMany({ where: { OR: [{ partyId: { in: ids } }, { listingId: { in: ids } }] } })
    await prisma.extractedOpportunity.deleteMany({ where: { id: { in: ids } } })
  }
}

async function seedParty(p: PartyFixture, orgId: string, rawEmailId: string): Promise<string> {
  const hoods = p.neighborhoods ?? []
  const row = await prisma.extractedOpportunity.create({
    data: {
      organizationId: orgId, rawEmailId, isTestData: true,
      category: p.role === 'buyer' ? Category.BUYER_ISO : Category.RENTER_INQUIRY,
      transactionType: p.role === 'buyer' ? TransactionType.BUYER_NEED : TransactionType.RENTER_NEED,
      extractedTitle: p.name, extractedSummary: `${p.role} demand fixture`,
      classificationReason: 'brief-7.1 demo seed', confidenceScore: 0.9,
      minPrice: p.budgetMin ?? null, maxPrice: p.budgetMax ?? null,
      neighborhoods: hoods, neighborhood: hoods[0] ?? null, borough: p.borough ?? null,
      minBeds: p.bedsMin ?? null, maxBeds: p.bedsMax ?? null,
      mustHaves: p.cashOnly ? 'cash only' : null, timeline: p.timing ?? null,
      sourceBrokerage: brokerageFor(p.source), sourceAgentName: p.name,
      createdAt: daysAgoDate(p.createdDaysAgo),
    },
    select: { id: true },
  })
  return row.id
}

async function seedListing(l: ListingFixture, orgId: string, rawEmailId: string): Promise<string> {
  const cat = l.category as Category
  const row = await prisma.extractedOpportunity.create({
    data: {
      organizationId: orgId, rawEmailId, isTestData: true,
      category: cat,
      transactionType: RENTAL_CATS.has(cat) ? TransactionType.RENTAL : TransactionType.SALE,
      extractedTitle: l.address ?? l.category, extractedSummary: 'listing fixture (brief-7.1 demo)',
      classificationReason: 'brief-7.1 demo seed', confidenceScore: 0.9,
      address: l.address ?? null, neighborhood: l.neighborhood ?? null, borough: l.borough ?? null,
      beds: l.beds ?? null, price: l.price ?? null,
      createdAt: daysAgoDate(l.createdDaysAgo),
    },
    select: { id: true },
  })
  return row.id
}

async function purgeAllDemoOrgs(): Promise<number> {
  const orgs = await prisma.organization.findMany({ where: { slug: { startsWith: 'matching-demo-' } }, select: { id: true, slug: true } })
  for (const o of orgs) {
    await wipeOrg(o.id)
    await prisma.rawEmail.deleteMany({ where: { organizationId: o.id } })
    await prisma.auditLog.deleteMany({ where: { organizationId: o.id } })
    await prisma.organization.delete({ where: { id: o.id } })
  }
  return orgs.length
}

async function main() {
  if (!isMatchingTestModeOnly()) {
    console.error('✗ REFUSING TO RUN: MATCHING_TEST_MODE_ONLY must be "true".')
    console.error('  This seeder is test-mode-only. Run with:')
    console.error('  MATCHING_TEST_MODE_ONLY=true npx tsx scripts/seed-tiered-matches.ts')
    process.exit(1)
  }

  if (PURGE_ONLY) {
    const n = await purgeAllDemoOrgs()
    console.log(`Purged ${n} matching-demo-* org(s) and their rows.`)
    await prisma.$disconnect()
    return
  }

  const fixtures = loadFixtures()
  console.log('SEED TIERED MATCHES (Brief 7.1 demo data)')
  console.log('═'.repeat(72))
  console.log(`Fixtures: ${fixtures.length} | per-run cap $${RUN_CAP_USD.toFixed(2)}\n`)

  const dist: Record<MatchTier, number> = { HOT: 0, WARM: 0, POSSIBLE: 0 }
  let sePriorityCount = 0
  let matchesWritten = 0
  let totalCost = 0
  let aborted = false

  for (const fx of fixtures) {
    if (totalCost >= RUN_CAP_USD) {
      console.log(`\n⛔ RUN CAP $${RUN_CAP_USD} reached (spent $${totalCost.toFixed(4)}). Stopping before ${fx.id}.`)
      aborted = true
      break
    }

    const { orgId, rawEmailId } = await ensureOrgAndEmail(orgSlugFor(fx.id))
    await wipeOrg(orgId)

    const partyFixtures = fx.kind === 'ranking' ? (fx.parties ?? []) : (fx.party ? [fx.party] : [])
    const listingId = await seedListing(fx.listing, orgId, rawEmailId)
    for (const pf of partyFixtures) await seedParty(pf, orgId, rawEmailId)

    let fixtureMatches = 0
    try {
      const res = await findMatchesForListing(listingId, { limit: 50 })
      totalCost += res.costUSD

      for (const r of res.results) {
        const dbTier = TIER_DB[r.tier]
        await prisma.match.upsert({
          where: { opportunityId_counterpartId_counterpartType: { opportunityId: listingId, counterpartId: r.party.id, counterpartType: 'opportunity' } },
          update: { score: tierToScore(r.tier, r.sourceBadge), tier: dbTier, reason: r.reason },
          create: {
            organizationId: orgId,
            opportunityId: listingId,
            counterpartId: r.party.id,
            counterpartType: 'opportunity',
            score: tierToScore(r.tier, r.sourceBadge),
            tier: dbTier,
            reason: r.reason,
            seen: false,
          },
        })
        dist[dbTier]++
        if (r.sourceBadge === 'streeteasy_expert') sePriorityCount++
        matchesWritten++
        fixtureMatches++
      }
    } catch (e) {
      if (e instanceof MatchingCostAbort) { totalCost = e.runningCostUsd; aborted = true; console.log(`  ⚠︎ ${fx.id}: cost kill-switch tripped — ${e.message}`); break }
      console.log(`  ⚠︎ ${fx.id}: ${(e as Error).message}`)
      continue
    }

    console.log(`  ✓ ${fx.id.padEnd(42)} ${String(fixtureMatches).padStart(2)} match(es)  Σ$${totalCost.toFixed(4)}`)
  }

  console.log('\n' + '═'.repeat(72))
  console.log(`MATCHES WRITTEN:   ${matchesWritten}`)
  console.log(`TIER DISTRIBUTION: HOT ${dist.HOT} · WARM ${dist.WARM} · POSSIBLE ${dist.POSSIBLE}`)
  console.log(`SE-PRIORITY ROWS:  ${sePriorityCount} (render the ⭐ SE Expert badge)`)
  console.log(`TOTAL SPEND:       $${totalCost.toFixed(4)}${aborted ? '  (ABORTED at cap)' : ''}`)
  console.log('═'.repeat(72))
  console.log('\nDemo rows are LEFT IN PLACE under matching-demo-* orgs (isTestData=true).')
  console.log('To remove them:  MATCHING_TEST_MODE_ONLY=true npx tsx scripts/seed-tiered-matches.ts --purge')

  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })

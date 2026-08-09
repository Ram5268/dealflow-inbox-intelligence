// Brief 7.0 — matching-engine fixture harness.
//
// Mirrors scripts/extractor-fixture-harness.ts: loads the hand-crafted match
// scenarios under test/fixtures/matches/, seeds each party+listing into Postgres
// (isTestData=true, under a DEDICATED throwaway org so the 56 real seed rows are
// never touched), runs the REAL engine (findMatchesForListing), grades the
// predicted tier + reason themes against the fixture's ground truth, then tears
// the rows back down. Produces an HONEST per-tier confusion matrix — not a single
// vanity accuracy number.
//
// Isolation: everything lives under org slug 'matching-fixtures-test'. The engine
// scopes candidate queries by organizationId, so a fixture only ever matches the
// rows this harness seeded for it. Nothing here is a production trigger path.
//
// Usage:
//   npx tsx scripts/matching-fixture-harness.ts [--filter <bucket>] [--run-cap <usd>]
import 'dotenv/config'
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Category, TransactionType } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { SUPPLY_RENTAL } from '../lib/domain/Categories'
import { findMatchesForListing } from '../lib/matching/engine'
import { SOURCE_BOOST } from '../lib/matching/ranking'
import { MatchingCostAbort } from '../lib/matching/cost'
import type { SourceBadge, Tier } from '../lib/matching/types'

const FIXTURE_ROOT = join(process.cwd(), 'test', 'fixtures', 'matches')
const REPORT_PATH = join(FIXTURE_ROOT, 'last-run-report.json')
const TEST_ORG_SLUG = 'matching-fixtures-test'
const HARNESS_EMAIL_KEY = 'matching-fixture-harness-email'

const argv = process.argv.slice(2)
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const FILTER = flag('--filter')?.toLowerCase()
const RUN_CAP_USD = flag('--run-cap') ? parseFloat(flag('--run-cap')!) : 1.0

const RENTAL_CATS = new Set<Category>(SUPPLY_RENTAL)
const TIERS: Tier[] = ['Hot', 'Warm', 'Possible', 'None']

// ── Fixture types ────────────────────────────────────────────────────────────
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
  edgeCase?: boolean
  description: string
  party?: PartyFixture
  parties?: PartyFixture[]
  listing: ListingFixture
  expected: {
    tier?: Tier
    reasonThemes?: string[]
    shouldMatch?: boolean
    sePriority?: boolean
    sameTier?: Exclude<Tier, 'None'>
  }
  __bucket: string
}

function loadFixtures(): MatchFixture[] {
  const out: MatchFixture[] = []
  for (const f of readdirSync(FIXTURE_ROOT).filter(x => x.endsWith('.json') && x !== 'last-run-report.json')) {
    const bucket = f.replace(/\.json$/, '')
    if (FILTER && bucket !== FILTER) continue
    const arr = JSON.parse(readFileSync(join(FIXTURE_ROOT, f), 'utf8')) as MatchFixture[]
    for (const fx of arr) { fx.__bucket = bucket; out.push(fx) }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

// ── Seed helpers ─────────────────────────────────────────────────────────────
function daysAgoDate(n: number): Date { return new Date(Date.now() - n * 86_400_000) }

function brokerageFor(source: SourceBadge): string {
  return source === 'streeteasy_expert' ? 'StreetEasy Experts' : source === 'mojo' ? 'Mojo' : 'Elliman Inbox'
}

async function ensureOrgAndEmail(): Promise<{ orgId: string; rawEmailId: string }> {
  const org = await prisma.organization.upsert({
    where: { slug: TEST_ORG_SLUG },
    update: {},
    create: { name: 'Matching Fixtures (throwaway)', slug: TEST_ORG_SLUG },
    select: { id: true },
  })
  const email = await prisma.rawEmail.upsert({
    where: { graphMessageId: HARNESS_EMAIL_KEY },
    update: {},
    create: {
      graphMessageId: HARNESS_EMAIL_KEY, subject: 'Matching fixture placeholder',
      receivedDateTime: new Date(), organizationId: org.id,
    },
    select: { id: true },
  })
  return { orgId: org.id, rawEmailId: email.id }
}

async function wipeTestOrg(orgId: string): Promise<void> {
  // Remove any leftover fixture rows (and dismissals) so a crashed prior run can't
  // pollute the pool. Scoped strictly to the throwaway org.
  const opps = await prisma.extractedOpportunity.findMany({ where: { organizationId: orgId }, select: { id: true } })
  const ids = opps.map(o => o.id)
  if (ids.length) {
    await prisma.matchDismissal.deleteMany({ where: { OR: [{ partyId: { in: ids } }, { listingId: { in: ids } }] } })
    await prisma.match.deleteMany({ where: { opportunityId: { in: ids } } })
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
      classificationReason: 'fixture', confidenceScore: 0.9,
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
      extractedTitle: l.address ?? l.category, extractedSummary: 'listing fixture',
      classificationReason: 'fixture', confidenceScore: 0.9,
      address: l.address ?? null, neighborhood: l.neighborhood ?? null, borough: l.borough ?? null,
      beds: l.beds ?? null, price: l.price ?? null,
      createdAt: daysAgoDate(l.createdDaysAgo),
    },
    select: { id: true },
  })
  return row.id
}

// ── Reason-theme matching (semantic-ish; borough/neighborhood literal) ────────
const THEME_SYNONYMS: Record<string, string[]> = {
  // Rentals: the reason may frame the money dimension as "rent" OR "price/budget";
  // both satisfy the theme (the theme asserts the reason discussed cost).
  price: ['price', 'budget', 'range', 'asking', 'list', 'within', '$', 'under', 'over', 'below', 'above', 'ceiling'],
  rent: ['rent', '/mo', 'per month', 'month', 'lease', 'price', 'budget', '$', 'ceiling', 'range'],
  beds: ['bed', 'bedroom', 'br', '2br', '3br', '4br', 'studio'],
}
// Neighborhood-name themes: accept the common abbreviation a reason may use
// (the model writes "LES" for Lower East Side, "UES" for Upper East Side, etc.).
// Same alias normalization the extractor harness applies — a theme asserts the
// reason referenced the neighborhood, and an unambiguous abbreviation satisfies it.
const NBHD_ABBR: Record<string, string[]> = {
  'lower east side': ['les'],
  'upper east side': ['ues'],
  'upper west side': ['uws'],
  'financial district': ['fidi'],
  'west village': ['wv'],
  'long island city': ['lic'],
  'bedford-stuyvesant': ['bed-stuy', 'bedstuy', 'bed stuy'],
}
function themeFound(reason: string, theme: string): boolean {
  const r = reason.toLowerCase()
  const t = theme.toLowerCase()
  if (r.includes(t)) return true
  for (const s of THEME_SYNONYMS[t] ?? []) if (r.includes(s)) return true
  for (const s of NBHD_ABBR[t] ?? []) if (r.includes(s)) return true
  return false
}

// ── Grading ──────────────────────────────────────────────────────────────────
type Status = 'pass' | 'fail'
interface PartyGrade {
  partyName: string
  source: SourceBadge
  expectedTier: Tier
  predictedTier: Tier
  tierStatus: Status
  reasonThemesStatus?: Status
  missingThemes?: string[]
  reason?: string
}
interface FixtureReport {
  id: string
  bucket: string
  kind: 'tier' | 'ranking'
  edgeCase: boolean
  parties: PartyGrade[]
  sePriority?: 'pass' | 'fail' | 'inconclusive' | null
  costUsd: number
  pass: boolean   // fixture-level: all party tiers pass, themes pass, SE-priority not fail
  error?: string | null
}

async function runFixture(fx: MatchFixture, orgId: string, rawEmailId: string): Promise<FixtureReport> {
  const partyFixtures = fx.kind === 'ranking' ? (fx.parties ?? []) : (fx.party ? [fx.party] : [])
  const seededParty: { fx: PartyFixture; id: string }[] = []
  const listingId = await seedListing(fx.listing, orgId, rawEmailId)
  for (const pf of partyFixtures) seededParty.push({ fx: pf, id: await seedParty(pf, orgId, rawEmailId) })

  let costUsd = 0
  const grades: PartyGrade[] = []
  let sePriority: FixtureReport['sePriority'] = fx.kind === 'ranking' ? null : undefined
  let error: string | null = null

  try {
    const res = await findMatchesForListing(listingId, { limit: 50 })
    costUsd = res.costUSD
    const byId = new Map(res.results.map(r => [r.party.id, r]))

    for (const sp of seededParty) {
      const hit = byId.get(sp.id)
      const predictedTier: Tier = hit ? hit.tier : 'None'
      const expectedTier: Tier = fx.kind === 'ranking' ? (fx.expected.sameTier ?? 'Possible') : (fx.expected.tier ?? 'None')
      const g: PartyGrade = {
        partyName: sp.fx.name, source: sp.fx.source,
        expectedTier, predictedTier,
        tierStatus: predictedTier === expectedTier ? 'pass' : 'fail',
        reason: hit?.reason,
      }
      // Reason themes — only for single-party tier fixtures that matched.
      if (fx.kind === 'tier' && fx.expected.reasonThemes?.length && hit) {
        const missing = fx.expected.reasonThemes.filter(t => !themeFound(hit.reason, t))
        g.reasonThemesStatus = missing.length ? 'fail' : 'pass'
        g.missingThemes = missing
      }
      grades.push(g)
    }

    // SE-priority invariant for ranking fixtures: among results sharing a tier,
    // a higher source boost must appear at a strictly earlier index. Exercised
    // only when at least two of the seeded parties share a tier.
    if (fx.kind === 'ranking') {
      const ranked = res.results.filter(r => seededParty.some(sp => sp.id === r.party.id))
      let violation = false, exercised = false
      for (let i = 0; i < ranked.length; i++) {
        for (let j = i + 1; j < ranked.length; j++) {
          if (ranked[i].tier === ranked[j].tier) {
            exercised = true
            if (SOURCE_BOOST[ranked[i].sourceBadge] < SOURCE_BOOST[ranked[j].sourceBadge]) violation = true
          }
        }
      }
      const allPresent = ranked.length === seededParty.length
      sePriority = violation || !allPresent ? 'fail' : exercised ? 'pass' : 'inconclusive'
    }
  } catch (e) {
    if (e instanceof MatchingCostAbort) { error = e.message; costUsd = e.runningCostUsd }
    else error = (e as Error).message
  } finally {
    const ids = [listingId, ...seededParty.map(s => s.id)]
    await prisma.matchDismissal.deleteMany({ where: { OR: [{ partyId: { in: ids } }, { listingId: { in: ids } }] } })
    await prisma.match.deleteMany({ where: { opportunityId: { in: ids } } })
    await prisma.extractedOpportunity.deleteMany({ where: { id: { in: ids } } })
  }

  const tiersPass = grades.every(g => g.tierStatus === 'pass')
  const themesPass = grades.every(g => g.reasonThemesStatus !== 'fail')
  const sePass = sePriority !== 'fail'
  return {
    id: fx.id, bucket: fx.__bucket, kind: fx.kind, edgeCase: !!fx.edgeCase,
    parties: grades, sePriority, costUsd,
    pass: !error && tiersPass && themesPass && sePass, error,
  }
}

// Dismissal filter smoke test — seed a would-be-Hot pair, dismiss it, assert the
// party is absent from results. Costs $0 (a dismissed pair is dropped before any
// Sonnet call). Returns pass/fail.
async function dismissalSmokeTest(orgId: string, rawEmailId: string): Promise<{ pass: boolean; detail: string }> {
  const listingId = await seedListing(
    { category: 'ACTIVE_SALE_LISTING', address: '1 Dismissal Way', neighborhood: 'Chelsea', borough: 'Manhattan', beds: 2, price: 2050000, createdDaysAgo: 1 },
    orgId, rawEmailId)
  const partyId = await seedParty(
    { role: 'buyer', source: 'inbox', name: 'Dismissed Buyer', budgetMin: 1900000, budgetMax: 2100000, neighborhoods: ['Chelsea'], bedsMin: 2, bedsMax: 2, cashOnly: false, timing: null, createdDaysAgo: 1 },
    orgId, rawEmailId)
  try {
    await prisma.matchDismissal.create({ data: { partyId, listingId } })
    const res = await findMatchesForListing(listingId, { limit: 50 })
    const present = res.results.some(r => r.party.id === partyId)
    return { pass: !present && res.costUSD === 0, detail: present ? 'FAIL: dismissed party still returned' : `pass: dismissed pair absent, $${res.costUSD} spent (no tiering call)` }
  } catch (e) {
    return { pass: false, detail: `FAIL: ${(e as Error).message}` }
  } finally {
    const ids = [listingId, partyId]
    await prisma.matchDismissal.deleteMany({ where: { OR: [{ partyId: { in: ids } }, { listingId: { in: ids } }] } })
    await prisma.extractedOpportunity.deleteMany({ where: { id: { in: ids } } })
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
const DISCLAIMER =
  'Fixtures are self-authored ground truth. This report measures internal consistency ' +
  'of the tiering rubric against Ryan\'s own judgment, NOT external validity. Real ' +
  'accuracy validation requires labeled samples from actual Mojo/inbox data — deferred ' +
  'to a future brief once real data sources are enabled.'

async function main() {
  const fixtures = loadFixtures()
  const stamp = new Date().toISOString()
  console.log('MATCHING FIXTURE HARNESS —', stamp)
  console.log('═'.repeat(78))
  console.log(`Fixtures: ${fixtures.length}${FILTER ? ` (filter: ${FILTER})` : ''} | per-run cap $${RUN_CAP_USD.toFixed(2)}\n`)

  const { orgId, rawEmailId } = await ensureOrgAndEmail()
  await wipeTestOrg(orgId)

  const reports: FixtureReport[] = []
  let runningCost = 0
  let aborted = false

  for (const fx of fixtures) {
    if (runningCost >= RUN_CAP_USD) {
      console.log(`\n⛔ RUN CAP $${RUN_CAP_USD} reached (running $${runningCost.toFixed(4)}). Stopping before ${fx.id}.`)
      aborted = true
      break
    }
    const rep = await runFixture(fx, orgId, rawEmailId)
    runningCost += rep.costUsd
    reports.push(rep)
    const mark = rep.error ? '⚠︎' : rep.pass ? '✓' : '✗'
    const se = rep.sePriority ? ` SE:${rep.sePriority}` : ''
    const tierStr = rep.parties.map(p => p.tierStatus === 'pass' ? `${p.source[0].toUpperCase()}✓` : `${p.source[0].toUpperCase()}✗(${p.predictedTier})`).join(' ')
    console.log(`${mark} ${rep.id.padEnd(42)} ${tierStr.padEnd(24)}${se}  $${rep.costUsd.toFixed(4)}  Σ$${runningCost.toFixed(4)}${rep.error ? `  ERR: ${rep.error}` : ''}`)
  }

  const dismissal = await dismissalSmokeTest(orgId, rawEmailId)

  printSummary(reports, runningCost, aborted, dismissal, stamp, fixtures.length)
}

function printSummary(
  reports: FixtureReport[], runningCost: number, aborted: boolean,
  dismissal: { pass: boolean; detail: string }, stamp: string, totalFixtures: number,
) {
  // ── Per-tier confusion matrix (rows = expected, cols = predicted) ──────────
  const matrix: Record<Tier, Record<Tier, number>> = {
    Hot: { Hot: 0, Warm: 0, Possible: 0, None: 0 },
    Warm: { Hot: 0, Warm: 0, Possible: 0, None: 0 },
    Possible: { Hot: 0, Warm: 0, Possible: 0, None: 0 },
    None: { Hot: 0, Warm: 0, Possible: 0, None: 0 },
  }
  for (const r of reports) for (const p of r.parties) matrix[p.expectedTier][p.predictedTier]++

  console.log('\n' + '═'.repeat(78))
  console.log('PER-TIER CONFUSION MATRIX  (rows = expected, cols = predicted; diagonal = correct)')
  console.log('═'.repeat(78))
  console.log(`  ${'expected ↓ / pred →'.padEnd(14)}${TIERS.map(t => (t === 'None' ? 'None(filt)' : t).padStart(11)).join('')}`)
  let diag = 0, tot = 0
  for (const e of TIERS) {
    const row = TIERS.map(p => { tot += matrix[e][p]; if (e === p) diag += matrix[e][p]; return String(matrix[e][p]).padStart(11) }).join('')
    console.log(`  ${e.padEnd(14)}${row}`)
  }
  console.log(`\n  Tier exact-match: ${diag}/${tot} party-pairs (${tot ? ((diag / tot) * 100).toFixed(0) : 0}%)`)

  // ── Per-fixture PASS/FAIL ──────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(78))
  console.log('PER-FIXTURE PASS/FAIL')
  console.log('═'.repeat(78))
  for (const r of reports) {
    const mark = r.error ? '⚠︎' : r.pass ? '✓' : '✗'
    console.log(`  ${mark} ${r.id}${r.edgeCase ? ' [edge]' : ''}`)
    for (const p of r.parties) {
      if (p.tierStatus === 'fail')
        console.log(`       tier: ${p.source} expected ${p.expectedTier} → got ${p.predictedTier}`)
      if (p.reasonThemesStatus === 'fail')
        console.log(`       themes missing: ${p.missingThemes?.join(', ')} | reason: "${p.reason ?? ''}"`)
    }
    if (r.sePriority === 'fail') console.log(`       SE-priority VIOLATED`)
    if (r.sePriority === 'inconclusive') console.log(`       SE-priority inconclusive (seeded parties split across tiers)`)
    if (r.error) console.log(`       error: ${r.error}`)
  }

  // ── SE-priority boolean ────────────────────────────────────────────────────
  const rankFixtures = reports.filter(r => r.kind === 'ranking')
  const seFails = rankFixtures.filter(r => r.sePriority === 'fail')
  const seInconclusive = rankFixtures.filter(r => r.sePriority === 'inconclusive')
  const sePass = seFails.length === 0
  console.log('\n' + '═'.repeat(78))
  console.log('SE-PRIORITY INVARIANT (deterministic ranking boost: SE > Mojo > inbox within a tier)')
  console.log('═'.repeat(78))
  console.log(`  RESULT: ${sePass ? 'PASS ✓' : 'FAIL ✗'}  (${rankFixtures.length - seFails.length - seInconclusive.length} clean pass, ${seInconclusive.length} inconclusive, ${seFails.length} fail)`)
  console.log(`  DISMISSAL FILTER: ${dismissal.pass ? 'PASS ✓' : 'FAIL ✗'}  — ${dismissal.detail}`)

  // ── Bucket rollup + cost ───────────────────────────────────────────────────
  const buckets = [...new Set(reports.map(r => r.bucket))].sort()
  console.log('\n' + '═'.repeat(78))
  console.log('PER-BUCKET')
  console.log('═'.repeat(78))
  for (const b of buckets) {
    const rs = reports.filter(r => r.bucket === b)
    const passed = rs.filter(r => r.pass).length
    console.log(`  ${b.toUpperCase().padEnd(12)} ${passed}/${rs.length} fixtures pass`)
  }

  const fixturesPassed = reports.filter(r => r.pass).length
  const perFixtureAvg = reports.length ? runningCost / reports.length : 0
  console.log('\n' + '═'.repeat(78))
  console.log(`FIXTURES:        ${reports.length}/${totalFixtures} run${aborted ? ' (ABORTED at run cap)' : ''}`)
  console.log(`FIXTURE PASS:    ${fixturesPassed}/${reports.length}`)
  console.log(`SE-PRIORITY:     ${sePass ? 'PASS' : 'FAIL'} | DISMISSAL: ${dismissal.pass ? 'PASS' : 'FAIL'}`)
  console.log(`TOTAL SPEND:     $${runningCost.toFixed(4)}  (avg $${perFixtureAvg.toFixed(4)}/fixture)`)
  console.log('═'.repeat(78))
  console.log('\nHONESTY DISCLAIMER:')
  console.log(DISCLAIMER)

  writeFileSync(REPORT_PATH, JSON.stringify({
    stamp, filter: FILTER ?? null, totalFixtures, run: reports.length, aborted,
    confusionMatrix: matrix, sePriorityPass: sePass, seInconclusive: seInconclusive.map(r => r.id),
    dismissalPass: dismissal.pass, dismissalDetail: dismissal.detail,
    fixturesPassed, totalCostUsd: runningCost, perFixtureAvgUsd: perFixtureAvg,
    disclaimer: DISCLAIMER, reports,
  }, null, 2))
  console.log(`\nReport written to ${REPORT_PATH}`)
}

main().then(() => prisma.$disconnect()).catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })

// Brief 48 data step DS-2: top up Ryan's test buyers to 250 [Ryan 1.12,
// 2026-10-19: add 45 test buyers aimed at the CRM's seller pool].
//
// Based on the generator of the closed PR #4 (Brief 34 prep,
// scripts/seed-brief34-bk-multifamily-buyers.ts, commit 989943b): BUYER_ISO
// test rows (isTestData: true) for single-, two- and three-family homes,
// weighted to the CRM lead pool's Brooklyn/Ridgewood ZIPs, hanging off the
// shared 2020 seed anchor email so they never move the inbox sync's resume
// point. Changes from that generator [engineering precaution]:
//   - it counts only Ryan's organization's test buyers (PR #4 counted every
//     BUYER_ISO in the database, including 45 in fixture organizations);
//   - its own tag, [TEST_48], and ids test48-buyer-opp-NNN, so --restore can
//     delete exactly these;
//   - the agent names are obviously made up (PR #4 drew from a pool that
//     included Ryan's own name), with the seed sentinel email domain;
//   - it never creates the anchor email: it must already exist.
// The nightly picks them up as demand while SCORING_INCLUDE_TEST_BUYERS is
// 'true' (lib/matching/nightly/runScoring.ts).
import type { Prisma } from '@prisma/client'
import { fromRaw, getAdjacent, getBorough } from '../domain/Neighborhood'
import { emptyBeforeCopy, type BeforeCopy, type Row } from './common'
import { auditRow, count, inIds, json, type Tx } from './rows'
import type { Step } from './runner'

export const DS2_ACTION = 'BRIEF48_DS2_TEST_BUYERS_ADDED'
export const DS2_RESTORE_ACTION = 'BRIEF48_DS2_RESTORED'
export const TAG = '[TEST_48]'
export const ID_PREFIX = 'test48-buyer-opp-'
export const TARGET_TOTAL = 250 // test buyers in Ryan's organization afterwards [Ryan 1.12]
export const EXPECTED_TODAY = 205 // the count Ryan's OK was based on (Sep 26 note), so 45 are added
export const ANCHOR_GRAPH_ID = '[TEST_10]-anchor-email' // scripts/seed-stress-common.ts getOrgAndAnchor
export const SEED_DOMAIN = 'seed-test-48.dealflow.local'
const SEED = 0x48b

type Kind = 'single' | 'two' | 'three' | 'twoOrThree'

// ── From PR #4's generator (unchanged unless noted) ─────────────────────────
// Primary-neighborhood weights mirror the CRM lead pool's ZIP distribution
// (Sep 2026 Mojo import). Aggregate counts per area only.
export const HOOD_WEIGHTS: [string, number][] = [
  ['Bedford-Stuyvesant', 367], ['Park Slope', 175], ['Bushwick', 169], ['Crown Heights', 144],
  ['Ridgewood', 109], ['Carroll Gardens', 81], ['Williamsburg', 80], ['Greenpoint', 74],
  ['Clinton Hill', 56], ['Sunset Park', 50], ['Prospect Heights', 36], ['Boerum Hill', 30],
  ['Windsor Terrace', 25], ['East New York', 23], ['Prospect Lefferts Gardens', 15], ['Maspeth', 14],
]
const AFFORDABLE = new Set(['Bushwick', 'Ridgewood', 'Crown Heights', 'Bedford-Stuyvesant', 'East New York',
  'Prospect Lefferts Gardens', 'Maspeth', 'Sunset Park'])
const BROWNSTONE_BELT: [string, number][] = [['Park Slope', 3], ['Carroll Gardens', 2], ['Boerum Hill', 1],
  ['Prospect Heights', 1], ['Clinton Hill', 1]]
export const BAND: Record<string, [number, number]> = {
  'Park Slope': [2_600_000, 4_500_000], 'Carroll Gardens': [2_800_000, 4_800_000],
  'Boerum Hill': [2_700_000, 4_600_000], 'Prospect Heights': [2_300_000, 4_000_000],
  'Clinton Hill': [2_300_000, 4_000_000], 'Williamsburg': [1_900_000, 3_400_000],
  'Greenpoint': [1_900_000, 3_300_000], 'Windsor Terrace': [1_800_000, 2_900_000],
  'Bedford-Stuyvesant': [1_500_000, 2_500_000], 'Crown Heights': [1_400_000, 2_400_000],
  'Prospect Lefferts Gardens': [1_400_000, 2_400_000], 'Bushwick': [1_300_000, 2_100_000],
  'Sunset Park': [1_200_000, 2_000_000], 'Ridgewood': [1_100_000, 1_700_000],
  'Maspeth': [1_100_000, 1_600_000], 'East New York': [800_000, 1_300_000],
}
const KIND_MULT: Record<Kind, number> = { single: 0.85, two: 1.0, three: 1.2, twoOrThree: 1.1 }
const FHA_CAP: Record<Kind, number> = { single: 1_250_000, two: 1_600_000, three: 1_930_000, twoOrThree: 1_750_000 }
export const TYPES: Record<Kind, string[]> = {
  single: ['Single-Family', 'SFH', 'Townhouse'],
  two: ['Two-Family', '2-Family', 'Duplex'],
  three: ['Three-Family', '3-Family', 'Triplex'],
  twoOrThree: ['Two-Family', '2-Family', 'Duplex', 'Three-Family', '3-Family', 'Triplex'],
}
const UNITS: Record<Kind, number | null> = { single: 1, two: 2, three: 3, twoOrThree: null }
const BEDS: Record<Kind, [[number, number], [number, number]]> = {
  single: [[3, 4], [4, 5]], two: [[4, 5], [6, 7]], three: [[6, 7], [8, 10]], twoOrThree: [[4, 5], [8, 9]],
}
const LABEL: Record<Kind, string> = { single: 'single-family', two: 'two-family', three: 'three-family', twoOrThree: '2–3 family' }
const KIND_SHARE: [Kind, number][] = [['single', 23], ['two', 42], ['three', 35]]
const ARCH_MIX: Record<'single' | 'two' | 'three', [string, number][]> = {
  single: [['TRADITIONAL_FINANCING', 10], ['CASH_BUYER', 4], ['FIRST_TIME_FHA', 4], ['LUXURY_FINANCED', 2]],
  two: [['TRADITIONAL_FINANCING', 14], ['FIRST_TIME_FHA', 8], ['INVESTOR_LANDLORD', 8], ['CASH_BUYER', 4], ['EXCHANGE_1031', 3]],
  three: [['INVESTOR_LANDLORD', 12], ['EXCHANGE_1031', 6], ['TRADITIONAL_FINANCING', 6], ['CASH_BUYER', 4], ['FIRST_TIME_FHA', 2]],
}
const MUST_HAVES: Record<'single' | 'multi', string[]> = {
  single: ['backyard', 'parking', 'original details', 'renovated', 'near subway', 'finished basement'],
  multi: ['legal C of O', 'separate meters', 'owner unit delivered vacant', 'backyard', 'finished basement',
    'free-market units', 'near subway', 'parking', 'renovated'],
}
const DEALBREAKERS = ['rent-stabilized units', 'open HPD violations', 'major structural work', 'shared driveway',
  'no C of O', 'flood zone']
const TIMELINE: Record<string, string[]> = {
  TRADITIONAL_FINANCING: ['pre-approved, 60–90 days', 'lease ends in March, flexible', '3–6 months, pre-approved'],
  FIRST_TIME_FHA: ['FHA pre-approval in hand, 90 days', '6 months, FHA 3.5% down'],
  INVESTOR_LANDLORD: ['actively acquiring, can close in 30 days', 'flexible, buying 2–3 buildings this year'],
  CASH_BUYER: ['cash, can close in 3 weeks', 'flexible, cash ready'],
  EXCHANGE_1031: ['1031 — must close by Jan 15', '1031 — 45-day ID window, close by Feb 1'],
  LUXURY_FINANCED: ['20% down, no rush for the right house', 'relocating in spring, pre-approved'],
}

// Changed from PR #4: obviously made-up agents (no real person's name).
export const AGENT_FIRST = ['Pat', 'Jordan', 'Casey', 'Riley', 'Morgan', 'Avery', 'Quinn', 'Drew', 'Jamie', 'Robin']
export const AGENT_LAST = ['Example', 'Sample', 'Placeholder', 'Testwell', 'Demo', 'Fixture', 'Mockley', 'Seedwell']

function body(arch: string, kind: Kind, hoods: string, price: string): string {
  const k = LABEL[kind]
  switch (arch) {
    case 'TRADITIONAL_FINANCING': return kind === 'single'
      ? `Pre-approved buyer looking for a ${k} house in ${hoods}, ${price}. Family moving up from a rental, wants outdoor space.`
      : `Pre-approved buyer for a legal ${k} in ${hoods}, ${price}. Plans to live in the owner's unit and rent the rest.`
    case 'FIRST_TIME_FHA': return kind === 'single'
      ? `First-time buyer using FHA (3.5% down) for a ${k} home in ${hoods}, up to ${price.split('–')[1] ?? price}.`
      : `First-time buyer house-hacking with FHA — needs a legal ${k} with C of O in ${hoods}, ${price}. Will occupy one unit.`
    case 'INVESTOR_LANDLORD': return `Investor client adding to a small-multifamily portfolio — ${k} in ${hoods}, ${price}. Free-market units preferred, open to value-add.`
    case 'CASH_BUYER': return `All-cash buyer for a ${k} in ${hoods}, ${price}. No financing contingency, flexible on condition.`
    case 'EXCHANGE_1031': return `1031 exchange buyer — relinquished property closed, needs a ${k} in ${hoods}, ${price}. Timing is critical.`
    case 'LUXURY_FINANCED': return `Buyer for a single-family brownstone in ${hoods}, ${price}, financed with 20% down. Wants a garden and original details.`
    default: return `Buyer seeking a ${k} in ${hoods}, ${price}.`
  }
}

// Deterministic RNG (mulberry32), as scripts/seed-stress-common.ts makeRng:
// the dry run and --apply build exactly the same rows.
export function makeRng(seed: number) {
  let a = seed >>> 0
  const next = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)],
    chance: (p: number) => next() < p,
    weighted: <T>(buckets: readonly [T, number][]): T => {
      const total = buckets.reduce((s, [, w]) => s + w, 0)
      let r = next() * total
      for (const [v, w] of buckets) { if ((r -= w) <= 0) return v }
      return buckets[buckets.length - 1][0]
    },
  }
}

// Largest-remainder split of `total` across weighted keys.
export function allocate<K extends string>(total: number, weights: [K, number][]): [K, number][] {
  const s = weights.reduce((acc, [, w]) => acc + w, 0)
  const raw = weights.map(([k, w]) => ({ k, v: (total * w) / s }))
  const out = raw.map(({ k, v }) => [k, Math.floor(v)] as [K, number])
  let left = total - out.reduce((acc, [, n]) => acc + n, 0)
  const order = raw.map(({ v }, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac)
  for (let j = 0; left > 0; j++, left--) out[order[j % order.length].i][1]++
  return out
}

const round5k = (n: number) => Math.round(n / 5_000) * 5_000
const money = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2).replace(/0$/, '')}M` : `$${Math.round(n / 1000)}K`)
export const agentEmail = (name: string) => `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${SEED_DOMAIN}`

export type TestBuyer = Prisma.ExtractedOpportunityCreateManyInput & { id: string; extractedTitle: string; neighborhood: string }

// Pure: `n` test buyers, the same every time for the same n.
export function buildTestBuyers(n: number, orgId: string, rawEmailId: string): TestBuyer[] {
  for (const [h] of HOOD_WEIGHTS) {
    if (fromRaw(h) !== h) throw new Error(`"${h}" is not a canonical neighborhood`) // the matcher abstains on unknown names
    if (!BAND[h]) throw new Error(`no budget band for "${h}"`)
  }
  const rng = makeRng(SEED)
  const out: TestBuyer[] = []
  let i = 0
  for (const [base, kindCount] of allocate(n, KIND_SHARE)) {
    for (const [arch, archCount] of allocate(kindCount, ARCH_MIX[base as 'single' | 'two' | 'three'])) {
      for (let k = 0; k < archCount; k++, i++) {
        const kind: Kind = base !== 'single' && rng.chance(0.25) ? 'twoOrThree' : (base as Kind)
        const pool = arch === 'FIRST_TIME_FHA' ? HOOD_WEIGHTS.filter(([h]) => AFFORDABLE.has(h))
          : arch === 'LUXURY_FINANCED' ? BROWNSTONE_BELT : HOOD_WEIGHTS
        const primary = rng.weighted(pool)
        const adj = getAdjacent(primary).filter(h => fromRaw(h) === h)
        const hoods = Array.from(new Set([primary, ...(adj.length && rng.chance(0.55) ? [rng.pick(adj)] : [])]))
        const [bmin, bmax] = BAND[primary]
        const mult = KIND_MULT[kind] * (arch === 'LUXURY_FINANCED' ? 1.25 : 1)
        let minPrice = round5k(bmin * mult * (0.85 + 0.15 * rng.next()))
        let maxPrice = round5k(bmax * mult * (0.92 + 0.13 * rng.next()))
        if (arch === 'FIRST_TIME_FHA') { maxPrice = Math.min(maxPrice, FHA_CAP[kind]); minPrice = Math.min(minPrice, round5k(maxPrice * 0.75)) }
        if (maxPrice - minPrice < 150_000) minPrice = round5k(maxPrice * 0.8)
        const [[bLo, bHi], [xLo, xHi]] = BEDS[kind]
        const minBeds = rng.int(bLo, bHi)
        const maxBeds = Math.max(minBeds + 1, rng.int(xLo, xHi))
        const mh = MUST_HAVES[kind === 'single' ? 'single' : 'multi']
        const mustHaves = Array.from(new Set(Array.from({ length: rng.int(1, 3) }, () => rng.pick(mh)))).join(', ')
        const dealbreakers = Array.from(new Set(Array.from({ length: rng.int(1, 2) }, () => rng.pick(DEALBREAKERS)))).join(', ')
        const agent = `${rng.pick(AGENT_FIRST)} ${rng.pick(AGENT_LAST)}`
        const hoodLabel = hoods.join(' / ')
        out.push({
          id: `${ID_PREFIX}${String(i + 1).padStart(3, '0')}`,
          rawEmailId, organizationId: orgId,
          category: 'BUYER_ISO', transactionType: 'BUYER_NEED',
          extractedTitle: `${TAG} ${arch} — ${LABEL[kind]} — ${hoodLabel}`,
          extractedSummary: body(arch, kind, hoodLabel, `${money(minPrice)}–${money(maxPrice)}`),
          classificationReason: 'brief_48_seed', confidenceScore: 0.95, provenance: 'seed:brief48',
          buyerArchetype: arch,
          neighborhood: primary, borough: getBorough(primary) ?? undefined, neighborhoods: hoods,
          propertyTypes: TYPES[kind], propertyType: TYPES[kind][0], units: UNITS[kind] ?? undefined,
          minPrice, maxPrice, minBeds, maxBeds, bathsMin: kind === 'single' || kind === 'two' ? 2 : 3,
          mustHaves, dealbreakers, timeline: rng.pick(TIMELINE[arch]),
          criteriaActive: true, isTestData: true,
          sourceAgentName: agent, sourceAgentEmail: agentEmail(agent),
        })
      }
    }
  }
  return out
}

// ── Database ────────────────────────────────────────────────────────────────
export interface Ds2Facts {
  orgId: string
  testBuyers: number // BUYER_ISO, isTestData, Ryan's organization
  realBuyers: number // BUYER_ISO, not test, Ryan's organization
  testBuyersElsewhere: number // BUYER_ISO test rows of other organizations (left alone)
  alreadyThere: number // rows with this run's tag or ids
  anchorId: string | null
}

export async function loadDs2Facts(tx: Tx, orgId: string): Promise<Ds2Facts> {
  const anchors = await tx.$queryRawUnsafe<{ id: string }[]>(
    'SELECT id FROM "RawEmail" WHERE "graphMessageId" = $1 AND "organizationId" = $2', ANCHOR_GRAPH_ID, orgId)
  return {
    orgId,
    testBuyers: await count(tx, `SELECT count(*)::int AS n FROM "ExtractedOpportunity" WHERE "organizationId" = $1 AND category = 'BUYER_ISO' AND "isTestData"`, orgId),
    realBuyers: await count(tx, `SELECT count(*)::int AS n FROM "ExtractedOpportunity" WHERE "organizationId" = $1 AND category = 'BUYER_ISO' AND NOT "isTestData"`, orgId),
    testBuyersElsewhere: await count(tx, `SELECT count(*)::int AS n FROM "ExtractedOpportunity" WHERE "organizationId" <> $1 AND category = 'BUYER_ISO' AND "isTestData"`, orgId),
    alreadyThere: await count(tx, `SELECT count(*)::int AS n FROM "ExtractedOpportunity" WHERE starts_with(id, $1) OR starts_with("extractedTitle", $2)`, ID_PREFIX, `${TAG} `),
    anchorId: anchors.length === 1 ? anchors[0].id : null,
  }
}

export interface Ds2Plan {
  topUp: number
  buyers: TestBuyer[]
  notices: string[] // printed loudly; not refusals
  refusals: string[] // --apply refuses
}

// Pure.
export function planDs2(f: Ds2Facts): Ds2Plan {
  const topUp = Math.max(0, TARGET_TOTAL - f.testBuyers)
  const notices: string[] = []
  const refusals: string[] = []
  if (f.testBuyers !== EXPECTED_TODAY) {
    notices.push(`Today's count is ${f.testBuyers} test buyers, not the ${EXPECTED_TODAY} Ryan's OK was based on, so the top-up to ${TARGET_TOTAL} is ${topUp}, not ${TARGET_TOTAL - EXPECTED_TODAY}. --apply needs --expect ${topUp}.`)
  }
  if (f.alreadyThere > 0) refusals.push(`${f.alreadyThere} ${TAG} test buyer(s) are already there: this step ran before (restore it first).`)
  if (!f.anchorId) refusals.push(`The shared seed anchor email isn't in this organization, so there's nothing for test buyers to hang off.`)
  if (topUp === 0) refusals.push(`There are already ${f.testBuyers} test buyers (target ${TARGET_TOTAL}): nothing to add.`)
  // Built for the dry run too (with a stand-in anchor id when it's missing), so it can show the split.
  const buyers = topUp > 0 ? buildTestBuyers(topUp, f.orgId, f.anchorId ?? '(none)') : []
  return { topUp, buyers, notices, refusals }
}

export function ds2Summary(p: Ds2Plan, f: Ds2Facts) {
  const tally = (key: (b: TestBuyer) => string) => p.buyers.reduce<Record<string, number>>((acc, b) => { acc[key(b)] = (acc[key(b)] ?? 0) + 1; return acc }, {})
  return {
    testBuyersToday: f.testBuyers,
    expectedToday: EXPECTED_TODAY,
    target: TARGET_TOTAL,
    topUp: p.topUp,
    afterwards: f.testBuyers + p.topUp,
    leftAlone: { realBuyersInRyansOrganization: f.realBuyers, testBuyersInOtherOrganizations: f.testBuyersElsewhere },
    byArchetype: tally(b => String(b.buyerArchetype)),
    byPrimaryNeighborhood: tally(b => b.neighborhood),
    byHomeType: tally(b => String((b.propertyTypes as string[])[0])),
    ids: p.buyers.length ? `${p.buyers[0].id} … ${p.buyers[p.buyers.length - 1].id}` : null,
    expect: p.topUp,
  }
}

export function newDs2Copy(database: string, orgId: string, now: Date, p: Ds2Plan, summary: Record<string, unknown>): BeforeCopy {
  const copy = emptyBeforeCopy('DS-2', database, orgId, now)
  copy.expect = p.topUp
  copy.counts = summary
  copy.created = { ExtractedOpportunity: p.buyers as unknown as Row[] }
  return copy
}

// Inside the write transaction: the before-copy first, then one insert.
export async function applyDs2(tx: Tx, p: Ds2Plan, copy: BeforeCopy, save: (c: BeforeCopy) => string): Promise<string> {
  const file = save(copy)
  const { count: inserted } = await tx.extractedOpportunity.createMany({ data: p.buyers })
  if (inserted !== p.buyers.length) throw new Error(`inserted ${inserted} of ${p.buyers.length} test buyers`)
  await auditRow(tx, copy.organizationId, DS2_ACTION, { beforeCopy: file.split('/').pop(), counts: copy.counts })
  return file
}

// Read-only after-check, DS-2 part.
export async function checkDs2(tx: Tx, copy: BeforeCopy): Promise<{ ok: boolean; counts: Record<string, number> }> {
  const ids = (copy.created.ExtractedOpportunity ?? []).map(r => r.id)
  const before = Number((copy.counts as { testBuyersToday?: number }).testBuyersToday ?? 0)
  const testNow = await count(tx, `SELECT count(*)::int AS n FROM "ExtractedOpportunity" WHERE "organizationId" = $1 AND category = 'BUYER_ISO' AND "isTestData"`, copy.organizationId)
  const present = await count(tx, `SELECT count(*)::int AS n FROM "ExtractedOpportunity"
WHERE id ${inIds(1)} AND "isTestData" AND category = 'BUYER_ISO' AND "organizationId" = $2 AND starts_with("extractedTitle", $3)`, json(ids), copy.organizationId, `${TAG} `)
  const counts = {
    'test buyers now': testNow,
    'test buyers expected': before + ids.length,
    'created test buyers missing': ids.length - present,
  }
  return { ok: testNow === before + ids.length && present === ids.length, counts }
}

export const ds2Step: Step<Ds2Plan> = {
  id: 'DS-2',
  title: `add test buyers to Ryan's organization, up to ${TARGET_TOTAL}`,
  unit: 'test buyers',
  restoreAction: DS2_RESTORE_ACTION,
  async plan(tx, orgId) {
    const facts = await loadDs2Facts(tx, orgId)
    const plan = planDs2(facts)
    return { plan, expect: plan.topUp, summary: ds2Summary(plan, facts), refusals: plan.refusals, notices: plan.notices, mentions: null }
  },
  newCopy: (database, orgId, now, r) => newDs2Copy(database, orgId, now, r.plan, r.summary),
  apply: (tx, r, copy, save) => applyDs2(tx, r.plan, copy, save),
  check: checkDs2,
}

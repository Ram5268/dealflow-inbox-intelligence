// Brief 34 prep — tops up test buyer demand to exactly 250 BUYER_ISO rows, aimed at
// the CRM's Mojo lead pool: Brooklyn/Ridgewood 1-, 2- and 3-family homes.
//
// Every row is isTestData=true and hangs off the shared seed anchor email (dated
// 2020). Per-buyer emails with recent dates would advance the inbox sync's resume
// point: runIncrementalSync resumes from the newest RawEmail of any kind
// (lib/backgroundSync.ts), so real mail older than a seed email would be skipped.
//
// Run:  npx tsx scripts/seed-brief34-bk-multifamily-buyers.ts [--dry-run] [--reset]
//   --dry-run  print the plan, write nothing
//   --reset    delete existing [TEST_34] buyers first, then reseed
import 'dotenv/config'
import { getOrgAndAnchor, ensureConnected, makeRng, brokerName, emailFrom } from './seed-stress-common'
import { fromRaw, getAdjacent, getBorough } from '../lib/domain/Neighborhood'
import { prisma } from '../lib/prisma'
import type { Prisma } from '@prisma/client'

const TAG = '[TEST_34]'
const TARGET_TOTAL = 250
const DRY = process.argv.includes('--dry-run')
const RESET = process.argv.includes('--reset')
const rng = makeRng(0x34b)

type Kind = 'single' | 'two' | 'three' | 'twoOrThree'

// Primary-neighborhood weights mirror the CRM lead pool's ZIP distribution
// (Sep 2026 Mojo import: 11221, 11233, 11216 → Bed-Stuy/Bushwick; 11215/11217 →
// Park Slope; 11385 → Ridgewood; …).
const HOOD_WEIGHTS: [string, number][] = [
  ['Bedford-Stuyvesant', 367], ['Park Slope', 175], ['Bushwick', 169], ['Crown Heights', 144],
  ['Ridgewood', 109], ['Carroll Gardens', 81], ['Williamsburg', 80], ['Greenpoint', 74],
  ['Clinton Hill', 56], ['Sunset Park', 50], ['Prospect Heights', 36], ['Boerum Hill', 30],
  ['Windsor Terrace', 25], ['East New York', 23], ['Prospect Lefferts Gardens', 15], ['Maspeth', 14],
]
const AFFORDABLE = new Set(['Bushwick', 'Ridgewood', 'Crown Heights', 'Bedford-Stuyvesant', 'East New York',
  'Prospect Lefferts Gardens', 'Maspeth', 'Sunset Park'])
const BROWNSTONE_BELT: [string, number][] = [['Park Slope', 3], ['Carroll Gardens', 2], ['Boerum Hill', 1],
  ['Prospect Heights', 1], ['Clinton Hill', 1]]

// Two-family budget band (min, max) per neighborhood; other kinds scale via KIND_MULT.
const BAND: Record<string, [number, number]> = {
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
// FHA loan limits (NYC, 1-/2-/3-unit) grossed up for 3.5% down.
const FHA_CAP: Record<Kind, number> = { single: 1_250_000, two: 1_600_000, three: 1_930_000, twoOrThree: 1_750_000 }

// propertyType feature is a case-insensitive substring match, so each buyer lists
// both Mojo's labels (Duplex/Triplex) and plain-English ones.
const TYPES: Record<Kind, string[]> = {
  single: ['Single-Family', 'SFH', 'Townhouse'],
  two: ['Two-Family', '2-Family', 'Duplex'],
  three: ['Three-Family', '3-Family', 'Triplex'],
  twoOrThree: ['Two-Family', '2-Family', 'Duplex', 'Three-Family', '3-Family', 'Triplex'],
}
const UNITS: Record<Kind, number | null> = { single: 1, two: 2, three: 3, twoOrThree: null }
const BEDS: Record<Kind, [[number, number], [number, number]]> = {  // [minBeds range, maxBeds range]
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

// Largest-remainder split of `total` across weighted keys.
function allocate<K extends string>(total: number, weights: [K, number][]): [K, number][] {
  const sum = weights.reduce((s, [, w]) => s + w, 0)
  const raw = weights.map(([k, w]) => ({ k, v: (total * w) / sum }))
  const out = raw.map(({ k, v }) => [k, Math.floor(v)] as [K, number])
  let left = total - out.reduce((s, [, n]) => s + n, 0)
  const order = raw.map(({ v }, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac)
  for (let j = 0; left > 0; j++, left--) out[order[j % order.length].i][1]++
  return out
}

const round5k = (n: number) => Math.round(n / 5_000) * 5_000
const money = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2).replace(/0$/, '')}M` : `$${Math.round(n / 1000)}K`)

async function main() {
  // Fail fast if any neighborhood isn't canonical — the matcher silently abstains on unknown names.
  for (const [h] of HOOD_WEIGHTS) {
    if (fromRaw(h) !== h) throw new Error(`"${h}" is not a canonical neighborhood (fromRaw → ${fromRaw(h)})`)
    if (!BAND[h]) throw new Error(`no budget band for "${h}"`)
  }

  await ensureConnected()
  const mine = await prisma.extractedOpportunity.count({ where: { category: 'BUYER_ISO', extractedTitle: { startsWith: `${TAG} ` } } })
  if (mine > 0 && !RESET) {
    console.log(`${mine} ${TAG} buyers already exist — skipping. Use --reset to reseed.`)
    await prisma.$disconnect(); return
  }
  const others = await prisma.extractedOpportunity.count({ where: { category: 'BUYER_ISO', NOT: { extractedTitle: { startsWith: `${TAG} ` } } } })
  const n = TARGET_TOTAL - others
  if (n <= 0) { console.log(`Already ${others} BUYER_ISO rows (target ${TARGET_TOTAL}) — nothing to add.`); await prisma.$disconnect(); return }

  const { orgId, rawEmailId } = await getOrgAndAnchor()
  const opps: Prisma.ExtractedOpportunityCreateManyInput[] = []
  const tally: Record<string, number> = {}
  let i = 0

  for (const [base, count] of allocate(n, KIND_SHARE)) {
    for (const [arch, archCount] of allocate(count, ARCH_MIX[base as 'single' | 'two' | 'three'])) {
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
        const agent = brokerName(rng)
        const hoodLabel = hoods.join(' / ')
        const priceLabel = `${money(minPrice)}–${money(maxPrice)}`
        const summary = body(arch, kind, hoodLabel, priceLabel)

        opps.push({
          id: `test34-buyer-opp-${String(i + 1).padStart(3, '0')}`,
          rawEmailId, organizationId: orgId,
          category: 'BUYER_ISO', transactionType: 'BUYER_NEED',
          extractedTitle: `${TAG} ${arch} — ${LABEL[kind]} — ${hoodLabel}`,
          extractedSummary: summary,
          classificationReason: 'brief_34_seed', confidenceScore: 0.95, provenance: 'seed:brief34',
          buyerArchetype: arch,
          neighborhood: primary, borough: getBorough(primary) ?? undefined, neighborhoods: hoods,
          propertyTypes: TYPES[kind], propertyType: TYPES[kind][0], units: UNITS[kind] ?? undefined,
          minPrice, maxPrice, minBeds, maxBeds, bathsMin: kind === 'single' || kind === 'two' ? 2 : 3,
          mustHaves, dealbreakers, timeline: rng.pick(TIMELINE[arch]),
          criteriaActive: true, isTestData: true,
          sourceAgentName: agent, sourceAgentEmail: emailFrom(agent),
        })
        tally[`${LABEL[kind]} · ${arch}`] = (tally[`${LABEL[kind]} · ${arch}`] ?? 0) + 1
      }
    }
  }

  const byHood: Record<string, number> = {}
  for (const o of opps) byHood[o.neighborhood as string] = (byHood[o.neighborhood as string] ?? 0) + 1
  console.log(`Existing BUYER_ISO (other tags): ${others}  →  adding ${opps.length}  →  total ${others + opps.length}`)
  console.log('\nBy type · archetype:'); console.table(tally)
  console.log('By primary neighborhood:'); console.table(byHood)
  console.log('Samples:'); for (const o of opps.slice(0, 4).concat(opps.slice(-3))) console.log(`  ${o.extractedTitle}  | ${money(o.minPrice as number)}–${money(o.maxPrice as number)} | beds ${o.minBeds}-${o.maxBeds}\n    ${o.extractedSummary}`)

  if (DRY) { console.log('\n--dry-run: nothing written.'); await prisma.$disconnect(); return }
  if (RESET && mine > 0) {
    const del = await prisma.extractedOpportunity.deleteMany({ where: { category: 'BUYER_ISO', extractedTitle: { startsWith: `${TAG} ` }, isTestData: true } })
    console.log(`\n--reset: deleted ${del.count} existing ${TAG} buyers.`)
  }
  const res = await prisma.extractedOpportunity.createMany({ data: opps, skipDuplicates: true })
  const total = await prisma.extractedOpportunity.count({ where: { category: 'BUYER_ISO' } })
  console.log(`\n✅ Inserted ${res.count} ${TAG} BUYER_ISO rows. BUYER_ISO total now: ${total}`)
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })

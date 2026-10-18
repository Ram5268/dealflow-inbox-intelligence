// Brief 32 Part A — ~300 [TEST_32] MojoContact SELLER rows with motivation
// diversity. LAYERS on top of existing [TEST_10] seed (does not touch it).
//
// intent=SELLER, isTestData=true, metadata.seedBrief='32'. Bulk-inserted via
// createMany (Railway sequential .create() is ~90ms/row). No embeddings — the
// Brief 32 scorer reads structured fields, not vectors.
//
// Run:  npx tsx scripts/seed-brief32-sellers.ts
import 'dotenv/config'
import { getOrgAndAnchor, ensureConnected, makeRng, HOODS, fullName, nycPhone, roundPrice, streetAddress } from './seed-stress-common'
import { prisma } from '../lib/prisma'
import type { Prisma } from '@prisma/client'
import { refuseLiveDatabase } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): test or seed data only, so it refuses
// any database but a *_perf or *_test one, with no override.
refuseLiveDatabase(process.env.DATABASE_URL, 'scripts/seed-brief32-sellers.ts (DATABASE_URL)')

const TAG = '[TEST_32]'
const rng = makeRng(0x32A) // reproducible

type Archetype =
  | 'PRE_FORECLOSURE' | 'HIGH_EQUITY' | 'ABSENTEE' | 'VACANT'
  | 'TIRED_LANDLORD' | 'FREE_AND_CLEAR' | 'GOLDEN_HANDCUFF' | 'EXPIRED'

const DISTRIBUTION: [Archetype, number][] = [
  ['PRE_FORECLOSURE', 40], ['HIGH_EQUITY', 60], ['ABSENTEE', 50], ['VACANT', 30],
  ['TIRED_LANDLORD', 30], ['FREE_AND_CLEAR', 40], ['GOLDEN_HANDCUFF', 30], ['EXPIRED', 20],
]

// Borough-weighted neighborhood pool. HOODS covers MN/BK/QN; add a few Bronx/SI
// canonical names so all 5 boroughs are represented.
interface SHood { name: string; borough: string; basePrice: number }
const EXTRA: SHood[] = [
  { name: 'Riverdale', borough: 'Bronx', basePrice: 700_000 },
  { name: 'Mott Haven', borough: 'Bronx', basePrice: 600_000 },
  { name: 'Concourse', borough: 'Bronx', basePrice: 500_000 },
  { name: 'St. George', borough: 'Staten Island', basePrice: 650_000 },
  { name: 'Tottenville', borough: 'Staten Island', basePrice: 800_000 },
]
const ALL_HOODS: SHood[] = [...HOODS.map(h => ({ name: h.name, borough: h.borough, basePrice: h.basePrice })), ...EXTRA]
const BY_BOROUGH: Record<string, SHood[]> = {}
for (const h of ALL_HOODS) (BY_BOROUGH[h.borough] ??= []).push(h)

function pickHood(): SHood {
  const borough = rng.weighted<string>([['Brooklyn', 35], ['Manhattan', 30], ['Queens', 20], ['Bronx', 10], ['Staten Island', 5]])
  return rng.pick(BY_BOROUGH[borough] ?? ALL_HOODS)
}

const BROWNSTONE_HOODS = new Set(['Park Slope', 'Prospect Heights', 'Fort Greene', 'Cobble Hill', 'Brooklyn Heights'])
const CONDO_HOODS = new Set(['Tribeca', 'Financial District', 'Chelsea', 'Soho', 'DUMBO', 'Long Island City', 'Williamsburg'])
const COOP_HOODS = new Set(['Upper East Side', 'Upper West Side', 'Midtown East', 'Midtown West'])

function propertyTypeFor(h: SHood, forceMulti: boolean): string {
  if (forceMulti) return rng.pick(['Duplex', 'Triplex', 'Multifamily'])
  if (BROWNSTONE_HOODS.has(h.name)) return rng.pick(['Townhouse', 'Brownstone'])
  if (CONDO_HOODS.has(h.name)) return 'Condo'
  if (COOP_HOODS.has(h.name)) return 'Coop'
  if (h.borough === 'Queens' || h.borough === 'Staten Island' || h.borough === 'Bronx') {
    return rng.weighted<string>([['SFH', 6], ['Multifamily', 2], ['Condo', 2]])
  }
  return rng.pick(['Condo', 'Coop'])
}

const FL_CA_NJ_PA = [
  '840 Ocean Dr, Miami Beach FL', '1200 Brickell Ave, Miami FL', '55 Sunset Blvd, Los Angeles CA',
  '300 Palm Canyon Dr, Palm Springs CA', '17 Hudson St, Hoboken NJ', '90 Bloomfield Ave, Montclair NJ',
  '221 Walnut St, Philadelphia PA', '4 Rittenhouse Sq, Philadelphia PA', '12 Beach Ave, Cape May NJ',
]
const BROKERAGES = ['Corcoran', 'Compass', "Sotheby's", 'Douglas Elliman', 'BOND', 'Serhant', 'Level Group', 'Brown Harris Stevens']

function estValueFor(h: SHood, pt: string): number {
  let v = h.basePrice * (0.75 + rng.next() * 0.6)
  if ((pt === 'Townhouse' || pt === 'Brownstone') && h.borough === 'Brooklyn') v = Math.max(v, 2_500_000 + rng.next() * 2_500_000)
  if (pt === 'Multifamily' || pt === 'Triplex' || pt === 'Duplex') v *= 1.15
  return roundPrice(v)
}

function bedsBathsFor(pt: string): [number, number] {
  const beds = pt === 'SFH' || pt.match(/Townhouse|Brownstone/) ? rng.int(3, 5)
    : pt.match(/Multi|Duplex|Triplex/) ? rng.int(3, 6)
    : rng.int(1, 4)
  const baths = Math.max(1, Math.round(beds * (0.5 + rng.next() * 0.4)))
  return [beds, baths]
}

function daysOut(min: number, max: number): Date {
  return new Date(Date.now() + rng.int(min, max) * 86400000)
}
function yearsAgo(min: number, max: number): Date {
  return new Date(Date.now() - Math.round((min + rng.next() * (max - min)) * 365.25 * 86400000))
}

interface Built { data: Prisma.MojoContactCreateManyInput }

function buildSeller(arch: Archetype, i: number): Built {
  const h = pickHood()
  const forceMulti = arch === 'TIRED_LANDLORD'
  const pt = propertyTypeFor(h, forceMulti)
  const [propertyBeds, propertyBaths] = bedsBathsFor(pt)
  const estimatedValue = estValueFor(h, pt)
  const address = `${streetAddress(rng)}, ${h.borough} NY`
  const name = `${TAG} ${fullName(rng)}`
  const mojoId = `TEST32-S-${String(i + 1).padStart(4, '0')}`

  // Contact-quality arrays.
  const nPhones = rng.int(1, 5)
  const additionalPhones = Array.from({ length: nPhones }, () => nycPhone(rng))
  const phoneDncFlags = [false, ...additionalPhones.map(() => rng.chance(0.12))]
  const phoneTypes = [rng.chance(0.6) ? 'mobile' : 'landline', ...additionalPhones.map(() => (rng.chance(0.6) ? 'mobile' : 'landline'))]
  const additionalEmails = Array.from({ length: rng.int(1, 3) }, (_, k) => `alt${k}.${mojoId.toLowerCase()}@seed-test-32.dealflow.local`)
  const coOwnerFullName = rng.chance(0.4) ? fullName(rng) : null
  const batchRankCategory = rng.weighted<string>([['High', 30], ['Medium', 45], ['Low', 25]])
  const tags = ['seller', ...(rng.chance(0.2) ? ['ryan_listing'] : [])]

  // Defaults (no distress); overridden per archetype below.
  const d: Prisma.MojoContactCreateManyInput = {
    organizationId: '', // filled by caller
    mojoId, fullName: name, intent: 'SELLER', isTestData: true,
    address, city: 'New York', neighborhood: h.name,
    phone: additionalPhones[0], email: additionalEmails[0],
    propertyBeds, propertyBaths, propertyTypeDetail: pt, estimatedValue,
    unitCount: pt.match(/Multi|Duplex|Triplex/) ? rng.int(2, 6) : 1,
    yearBuilt: rng.int(1900, 2015),
    additionalPhones, additionalEmails, phoneDncFlags, phoneTypes, coOwnerFullName, batchRankCategory,
    tags, groups: [],
    preForeclosureStatus: 'NONE', ownerOccupied: null, isVacant: null,
    metadata: { seedBrief: '32', archetype: arch },
  }

  switch (arch) {
    case 'PRE_FORECLOSURE': {
      const kind = rng.weighted<'LIS' | 'NOD' | 'AUCTION'>([['LIS', 15], ['NOD', 15], ['AUCTION', 10]])
      d.preForeclosureStatus = kind === 'LIS' ? 'LIS_PENDENS' : kind === 'NOD' ? 'NOTICE_OF_DEFAULT' : 'AUCTION_SCHEDULED'
      d.foreclosureAuctionDate = kind === 'LIS' ? daysOut(60, 120) : kind === 'NOD' ? daysOut(30, 90) : daysOut(15, 45)
      d.mojoList = 'NYC Pre-Foreclosure'
      { const eq = roundPrice(estimatedValue * (0.2 + rng.next() * 0.5)); d.equityBalance = eq; d.totalLoanBalance = roundPrice(estimatedValue - eq) }
      d.loanInterestRate = 4 + rng.next() * 3
      d.ownerOccupied = rng.chance(0.5)
      break
    }
    case 'HIGH_EQUITY': {
      d.mojoList = 'High Equity Long-Term Owners'
      d.lastSaleDate = yearsAgo(25, 40)
      { const eq = roundPrice(estimatedValue * (0.85 + rng.next() * 0.15)); d.equityBalance = eq; d.totalLoanBalance = roundPrice(Math.max(0, estimatedValue - eq)) }
      d.loanInterestRate = rng.chance(0.5) ? null : 7 + rng.next() * 1.5
      d.ownerOccupied = true
      break
    }
    case 'ABSENTEE': {
      d.mojoList = 'Absentee Owners NYC'
      d.ownerOccupied = false
      d.alternateAddress = rng.pick(FL_CA_NJ_PA)
      d.lastSaleDate = yearsAgo(5, 30)
      { const eq = roundPrice(estimatedValue * (0.4 + rng.next() * 0.5)); d.equityBalance = eq; d.totalLoanBalance = roundPrice(Math.max(0, estimatedValue - eq)) }
      break
    }
    case 'VACANT': {
      d.mojoList = 'Vacant Properties NYC'
      d.isVacant = true
      d.alternateAddress = rng.pick(FL_CA_NJ_PA)
      d.ownerOccupied = false
      d.equityBalance = roundPrice(estimatedValue * (0.5 + rng.next() * 0.4))
      break
    }
    case 'TIRED_LANDLORD': {
      d.mojoList = 'Absentee Multifamily Investors'
      d.unitCount = rng.int(2, 6)
      d.alternateAddress = rng.pick(FL_CA_NJ_PA)
      d.ownerOccupied = false
      d.lastSaleDate = yearsAgo(8, 25)
      d.equityBalance = roundPrice(estimatedValue * (0.5 + rng.next() * 0.4))
      break
    }
    case 'FREE_AND_CLEAR': {
      d.mojoList = 'Free and Clear NYC'
      d.totalLoanBalance = 0
      d.loanInterestRate = null
      d.equityBalance = estimatedValue
      d.ownerOccupied = rng.chance(0.5)
      d.lastSaleDate = yearsAgo(6, 30)
      break
    }
    case 'GOLDEN_HANDCUFF': {
      d.mojoList = rng.chance(0.5) ? 'General NYC Leads' : null
      d.loanInterestRate = 2.5 + rng.next() * 1.0
      { const loan = roundPrice(estimatedValue * (0.4 + rng.next() * 0.3)); d.totalLoanBalance = loan; d.equityBalance = roundPrice(estimatedValue - loan) }
      d.ownerOccupied = true
      d.lastSaleDate = yearsAgo(2, 6)
      break
    }
    case 'EXPIRED': {
      d.mojoList = 'Cold Expired Listings'
      d.priorListingStatus = 'EXPIRED'
      d.priorListingDom = rng.int(90, 365)
      d.priorListingBrokerage = rng.pick(BROKERAGES)
      d.priorListingPrice = roundPrice(estimatedValue * (1.0 + rng.next() * 0.2))
      d.lastSaleDate = yearsAgo(4, 20)
      d.equityBalance = roundPrice(estimatedValue * (0.4 + rng.next() * 0.5))
      break
    }
  }
  return { data: d }
}

async function main() {
  await ensureConnected()
  const existing = await prisma.mojoContact.count({ where: { fullName: { startsWith: `${TAG} ` }, intent: 'SELLER' } })
  if (existing > 0) {
    console.log(`${existing} ${TAG} SELLER contacts already exist — skipping. Delete them for a fresh seed.`)
    await prisma.$disconnect(); return
  }

  const { orgId } = await getOrgAndAnchor()
  const rows: Prisma.MojoContactCreateManyInput[] = []
  let i = 0
  for (const [arch, n] of DISTRIBUTION) {
    for (let k = 0; k < n; k++, i++) {
      const b = buildSeller(arch, i)
      b.data.organizationId = orgId
      rows.push(b.data)
    }
  }

  // Chunked createMany.
  const CHUNK = 100
  let inserted = 0
  for (let c = 0; c < rows.length; c += CHUNK) {
    const res = await prisma.mojoContact.createMany({ data: rows.slice(c, c + CHUNK), skipDuplicates: true })
    inserted += res.count
    console.log(`  inserted ${inserted}/${rows.length}`)
  }

  const byArch: Record<string, number> = {}
  for (const [a, n] of DISTRIBUTION) byArch[a] = n
  console.log(`\n✅ Seeded ${inserted} ${TAG} SELLER contacts. Distribution:`, byArch)
  const ryanTagged = await prisma.mojoContact.count({ where: { fullName: { startsWith: `${TAG} ` }, intent: 'SELLER', tags: { has: 'ryan_listing' } } })
  console.log(`   ryan_listing tagged (capture prob): ${ryanTagged}`)
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })

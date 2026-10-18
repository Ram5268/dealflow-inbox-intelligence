// Brief 32 Part A — ~50 [TEST_32] BUYER_ISO ExtractedOpportunity rows with
// archetype diversity, each with a paired stub RawEmail. LAYERS on existing seed.
//
// Run:  npx tsx scripts/seed-brief32-buyers.ts
import 'dotenv/config'
import { getOrgAndAnchor, ensureConnected, makeRng, HOODS, brokerName, emailFrom } from './seed-stress-common'
import { prisma } from '../lib/prisma'
import type { Prisma } from '@prisma/client'
import { refuseLiveDatabase } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): test or seed data only, so it refuses
// any database but a *_perf or *_test one, with no override.
refuseLiveDatabase(process.env.DATABASE_URL, 'scripts/seed-brief32-buyers.ts (DATABASE_URL)')

const TAG = '[TEST_32]'
const rng = makeRng(0x32B)

interface ArchConfig {
  archetype: string
  count: number
  price: [number, number]
  beds: [number, number]
  propertyTypes: string[]
  hoodPool: string[]
  mustHaves: string[]
  dealbreakers: string
  timeline: string
  body: (h: string, price: string) => string
}

const LUX = ['Tribeca', 'West Village', 'Soho', 'Upper East Side', 'Noho']
const MID = ['Chelsea', 'Upper West Side', 'Park Slope', 'Cobble Hill', 'Williamsburg', 'Fort Greene', 'Prospect Heights']
const STARTER = ['Astoria', 'Long Island City', 'Bushwick', 'Harlem', 'Greenpoint']
const MULTI = ['Bushwick', 'Bedford-Stuyvesant', 'Fort Greene', 'Prospect Heights', 'Astoria']

const CONFIGS: ArchConfig[] = [
  {
    archetype: 'CASH_BUYER', count: 12, price: [1_000_000, 3_000_000], beds: [2, 3],
    propertyTypes: ['Condo', 'Coop'], hoodPool: MID, mustHaves: ['outdoor space', 'doorman', 'renovated', 'quiet'],
    dealbreakers: 'ground floor, walk-up above 4', timeline: 'flexible, cash ready',
    body: (h, p) => `Client is an all-cash buyer targeting ${h}, ${p}. No financing contingency — can close fast on the right unit.`,
  },
  {
    archetype: 'EXCHANGE_1031', count: 8, price: [1_500_000, 4_000_000], beds: [2, 3],
    propertyTypes: ['Condo', 'Multifamily'], hoodPool: MID, mustHaves: ['low carrying costs', 'elevator'],
    dealbreakers: 'high common charges', timeline: 'must close by Nov 15 for 1031',
    body: (h, p) => `1031 exchange buyer — identified relinquished property, must close by Nov 15. Seeking ${h} ${p}. Timing is critical.`,
  },
  {
    archetype: 'TRADITIONAL_FINANCING', count: 12, price: [800_000, 2_000_000], beds: [1, 3],
    propertyTypes: ['Condo', 'Coop'], hoodPool: [...MID, ...STARTER], mustHaves: ['laundry', 'natural light'],
    dealbreakers: 'no board approval risk', timeline: '3-6 months, pre-approved',
    body: (h, p) => `Pre-approved buyer, financing in place, seeking ${h} ${p}. Looking to close within 3-6 months.`,
  },
  {
    archetype: 'INVESTOR_LANDLORD', count: 10, price: [1_500_000, 4_000_000], beds: [3, 6],
    propertyTypes: ['Multifamily', 'Duplex', 'Townhouse'], hoodPool: MULTI, mustHaves: ['2+ units', 'positive cash flow', 'parking'],
    dealbreakers: 'rent-stabilized headaches', timeline: 'actively acquiring, flexible',
    body: (h, p) => `Investor seeking cash-flowing multifamily in ${h} ${p}. Wants 2+ units, strong cap rate. Building a portfolio.`,
  },
  {
    archetype: 'FIRST_TIME_FHA', count: 5, price: [500_000, 900_000], beds: [1, 2],
    propertyTypes: ['SFH', 'Condo'], hoodPool: STARTER, mustHaves: ['move-in ready'],
    dealbreakers: 'coop board (FHA)', timeline: '6 months, FHA pre-approval',
    body: (h, p) => `First-time buyer using FHA financing, budget ${p}, open to ${h}. Needs FHA-approved building.`,
  },
  {
    archetype: 'LUXURY_ALL_CASH', count: 3, price: [5_000_000, 12_000_000], beds: [3, 5],
    propertyTypes: ['Condo', 'Townhouse'], hoodPool: LUX, mustHaves: ['outdoor space', 'doorman', 'gym', 'views'],
    dealbreakers: 'anything below the 20th floor', timeline: 'discreet, no rush',
    body: (h, p) => `Discreet UHNW client, all cash, ${p}, seeking trophy ${h} residence. Privacy essential.`,
  },
]

async function main() {
  await ensureConnected()
  const existing = await prisma.extractedOpportunity.count({ where: { extractedTitle: { startsWith: `${TAG} ` }, category: 'BUYER_ISO' } })
  if (existing > 0) {
    console.log(`${existing} ${TAG} BUYER_ISO opps already exist — skipping. Delete them for a fresh seed.`)
    await prisma.$disconnect(); return
  }
  const { orgId } = await getOrgAndAnchor()

  const emails: Prisma.RawEmailCreateManyInput[] = []
  const opps: Prisma.ExtractedOpportunityCreateManyInput[] = []
  let i = 0
  for (const cfg of CONFIGS) {
    for (let k = 0; k < cfg.count; k++, i++) {
      const emailId = `test32-buyer-email-${String(i + 1).padStart(3, '0')}`
      const oppId = `test32-buyer-opp-${String(i + 1).padStart(3, '0')}`
      const hoods = Array.from(new Set([rng.pick(cfg.hoodPool), ...(rng.chance(0.5) ? [rng.pick(cfg.hoodPool)] : [])]))
      const [pmin, pmax] = cfg.price
      const minPrice = pmin + Math.round(rng.next() * (pmax - pmin) * 0.3)
      const maxPrice = pmax - Math.round(rng.next() * (pmax - pmin) * 0.3)
      const minBeds = cfg.beds[0]
      const maxBeds = cfg.beds[1]
      const agent = brokerName(rng)
      const priceLabel = `$${(minPrice / 1_000_000).toFixed(1)}M–$${(maxPrice / 1_000_000).toFixed(1)}M`
      const hoodLabel = hoods.join(' / ')
      const mustHaves = rng.chance(0.75)
        ? Array.from(new Set(Array.from({ length: rng.int(1, 3) }, () => rng.pick(cfg.mustHaves)))).join(', ')
        : null

      emails.push({
        id: emailId, graphMessageId: `TEST32-BUYER-${i + 1}`,
        subject: `${TAG} Buyer ISO — ${cfg.archetype}`,
        senderName: agent, senderEmail: emailFrom(agent),
        bodyContent: cfg.body(hoodLabel, priceLabel),
        receivedDateTime: new Date(Date.now() - rng.int(0, 20) * 86400000),
        organizationId: orgId, processed: true,
      })
      opps.push({
        id: oppId, rawEmailId: emailId, organizationId: orgId,
        category: 'BUYER_ISO', transactionType: 'BUYER_NEED',
        extractedTitle: `${TAG} ${cfg.archetype} — ${hoodLabel}`,
        extractedSummary: cfg.body(hoodLabel, priceLabel),
        classificationReason: 'brief_32_seed', confidenceScore: 0.95,
        buyerArchetype: cfg.archetype,
        neighborhoods: hoods, propertyTypes: cfg.propertyTypes,
        minPrice, maxPrice, minBeds, maxBeds,
        mustHaves, dealbreakers: cfg.dealbreakers, timeline: cfg.timeline,
        criteriaActive: true, isTestData: true,
        sourceAgentName: agent, sourceAgentEmail: emailFrom(agent),
      })
    }
  }

  await prisma.rawEmail.createMany({ data: emails, skipDuplicates: true })
  const res = await prisma.extractedOpportunity.createMany({ data: opps, skipDuplicates: true })

  const byArch: Record<string, number> = {}
  for (const c of CONFIGS) byArch[c.archetype] = c.count
  console.log(`\n✅ Seeded ${res.count} ${TAG} BUYER_ISO opps (+${emails.length} RawEmails). Distribution:`, byArch)
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })

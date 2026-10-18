import 'dotenv/config'
import { prisma } from '../lib/prisma'
import { getCurrentOrgId } from '../lib/auth/orgContext'
import { Category, TransactionType } from '@prisma/client'
import { refuseLiveDatabase } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): test or seed data only, so it refuses
// any database but a *_perf or *_test one, with no override.
refuseLiveDatabase(process.env.DATABASE_URL, 'scripts/seed-brief25-test-data.ts (DATABASE_URL)')

// Brief 2.5, Step 3 — controlled 4-category seed data for matcher validation.
//
// NOTE ON FILENAME: the brief asked for scripts/seed-test-data.ts, but a
// pre-existing tracked file of that name already exists (an older seed that
// calls embedText() — an embedding API call, so NOT $0-safe). To avoid
// clobbering tracked code, this brief's seed lives here instead. No LLM /
// embedding calls anywhere — pure DB inserts.
//
// 8 buyers + 8 renters + 20 sale listings + 20 rental listings = 56 rows.
// All are ExtractedOpportunity rows: the matcher (lib/matchmaking.ts) reads the
// demand side from BUYER_ISO / RENTER_INQUIRY opportunities, so buyers/renters
// live here too (not MojoContact — that table is preserved real data).
//
// Tagging: the schema has NO `emailSource` column, but it DOES have
// `isTestData` (ExtractedOpportunity:218). Per the brief's stated fallback we
// tag every seed row `isTestData: true` and prefix every id `SEED_`. Together
// those let a real matcher run filter test data out later.
//
// Idempotent: re-running deletes all SEED_ rows (+ their matches + the SEED
// parent email) and re-inserts. Prices are chosen against the real price-overlap
// math so the distribution (perfect / slight-over / way-over / slight-under /
// neighborhood-mismatch / no-match) is hand-verifiable in Step 4.

const RAW_EMAIL_ID = 'SEED_RAWEMAIL_00'

interface Demand { id: string; name: string; beds: number; hood: string; min: number; max: number }
interface Supply { id: string; addr: string; hood: string; beds: number; price: number; cat: Category; intent: string; target: string }

// ── 8 buyers (BUYER_ISO) ─────────────────────────────────────────────────────
const BUYERS: Demand[] = [
  { id: 'SEED_BUYER_01', name: 'Sarah Chen',    beds: 2, hood: 'Park Slope',        min: 1_500_000, max: 2_000_000 },
  { id: 'SEED_BUYER_02', name: 'Marcus Reid',   beds: 3, hood: 'West Village',      min: 3_000_000, max: 4_000_000 },
  { id: 'SEED_BUYER_03', name: 'Priya Shah',    beds: 1, hood: 'Manhattan',         min:   700_000, max:   900_000 },
  { id: 'SEED_BUYER_04', name: 'Tom Rivera',    beds: 4, hood: 'Brooklyn Heights',  min: 2_500_000, max: 3_500_000 },
  { id: 'SEED_BUYER_05', name: 'Ana Kowalski',  beds: 2, hood: 'Chelsea',           min: 2_000_000, max: 2_800_000 },
  { id: 'SEED_BUYER_06', name: 'Jordan Kim',    beds: 3, hood: 'Upper West Side',   min: 2_500_000, max: 3_200_000 },
  { id: 'SEED_BUYER_07', name: 'Elena Vasquez', beds: 1, hood: 'SoHo',              min: 1_100_000, max: 1_400_000 },
  { id: 'SEED_BUYER_08', name: 'Nikhil Rao',    beds: 2, hood: 'Long Island City',  min:   900_000, max: 1_300_000 },
]

// ── 8 renters (RENTER_INQUIRY) — beds 0 == studio ────────────────────────────
const RENTERS: Demand[] = [
  { id: 'SEED_RENTER_01', name: 'Mike Torres',  beds: 1, hood: 'West Village',     min: 3_500, max: 4_000 },
  { id: 'SEED_RENTER_02', name: 'Lauren Park',   beds: 0, hood: 'Midtown',          min: 2_500, max: 3_000 },
  { id: 'SEED_RENTER_03', name: 'Devon Wright',  beds: 2, hood: 'Williamsburg',     min: 4_500, max: 5_500 },
  { id: 'SEED_RENTER_04', name: 'Isabel Cruz',   beds: 1, hood: 'East Village',     min: 3_000, max: 3_600 },
  { id: 'SEED_RENTER_05', name: 'Henry Zhou',    beds: 3, hood: 'Upper West Side',  min: 6_500, max: 8_000 },
  { id: 'SEED_RENTER_06', name: 'Kai Bennett',   beds: 2, hood: 'Astoria',          min: 3_200, max: 4_000 },
  { id: 'SEED_RENTER_07', name: 'Sofia Marino',  beds: 0, hood: 'Lower East Side',  min: 2_200, max: 2_700 },
  { id: 'SEED_RENTER_08', name: 'Ravi Iyer',     beds: 2, hood: 'Park Slope',       min: 4_000, max: 4_800 },
]

const CS = Category.COMING_SOON_SALE, OM = Category.OFF_MARKET_SALE, AS = Category.ACTIVE_SALE_LISTING
const RL = Category.RENTAL_LISTING,   CR = Category.COMING_SOON_RENTAL

// ── 20 sale listings ─────────────────────────────────────────────────────────
const SALES: Supply[] = [
  // 5 perfect (price squarely in target buyer's range, same hood + beds)
  { id: 'SEED_SALE_01', addr: '461 6th St',         hood: 'Park Slope',         beds: 2, price:  1_750_000, cat: AS, intent: 'perfect',                target: 'SEED_BUYER_01' },
  { id: 'SEED_SALE_02', addr: '12 Bank St',         hood: 'West Village',       beds: 3, price:  3_500_000, cat: CS, intent: 'perfect',                target: 'SEED_BUYER_02' },
  { id: 'SEED_SALE_03', addr: '200 E 33rd St',      hood: 'Manhattan',          beds: 1, price:    800_000, cat: OM, intent: 'perfect',                target: 'SEED_BUYER_03' },
  { id: 'SEED_SALE_04', addr: '70 Willow St',       hood: 'Brooklyn Heights',   beds: 4, price:  3_000_000, cat: AS, intent: 'perfect',                target: 'SEED_BUYER_04' },
  { id: 'SEED_SALE_05', addr: '130 W 19th St',      hood: 'Chelsea',            beds: 2, price:  2_400_000, cat: CS, intent: 'perfect',                target: 'SEED_BUYER_05' },
  // 4 slight-over (1-3% above target buyer's max — the key fractional-overlap test)
  { id: 'SEED_SALE_06', addr: '88 7th Ave',         hood: 'Park Slope',         beds: 2, price:  2_050_000, cat: CS, intent: 'slight-over',            target: 'SEED_BUYER_01' },
  { id: 'SEED_SALE_07', addr: '21 Perry St',        hood: 'West Village',       beds: 3, price:  4_080_000, cat: OM, intent: 'slight-over',            target: 'SEED_BUYER_02' },
  { id: 'SEED_SALE_08', addr: '101 W 87th St',      hood: 'Upper West Side',    beds: 3, price:  3_264_000, cat: AS, intent: 'slight-over',            target: 'SEED_BUYER_06' },
  { id: 'SEED_SALE_09', addr: '5-20 46th Ave',      hood: 'Long Island City',   beds: 2, price:  1_326_000, cat: CS, intent: 'slight-over',            target: 'SEED_BUYER_08' },
  // 3 way-over (>8% above max — same hood+beds so ONLY price should disqualify)
  { id: 'SEED_SALE_10', addr: '15 W 20th St',       hood: 'Chelsea',            beds: 2, price:  3_200_000, cat: AS, intent: 'way-over',               target: 'SEED_BUYER_05' },
  { id: 'SEED_SALE_11', addr: '90 Hicks St',        hood: 'Brooklyn Heights',   beds: 4, price:  4_200_000, cat: OM, intent: 'way-over',               target: 'SEED_BUYER_04' },
  { id: 'SEED_SALE_12', addr: '250 W 88th St',      hood: 'Upper West Side',    beds: 3, price:  3_900_000, cat: CS, intent: 'way-over',               target: 'SEED_BUYER_06' },
  // 3 slight-under (5% below target buyer's min)
  { id: 'SEED_SALE_13', addr: '45 Christopher St',  hood: 'West Village',       beds: 3, price:  2_850_000, cat: CS, intent: 'slight-under',           target: 'SEED_BUYER_02' },
  { id: 'SEED_SALE_14', addr: '55 Pineapple St',    hood: 'Brooklyn Heights',   beds: 4, price:  2_375_000, cat: AS, intent: 'slight-under',           target: 'SEED_BUYER_04' },
  { id: 'SEED_SALE_15', addr: '300 Columbus Ave',   hood: 'Upper West Side',    beds: 3, price:  2_375_000, cat: OM, intent: 'slight-under',           target: 'SEED_BUYER_06' },
  // 3 neighborhood-mismatch, price-match (in-range price, cross-borough hood, same beds)
  { id: 'SEED_SALE_16', addr: '155 E 76th St',      hood: 'Upper East Side',    beds: 2, price:  1_750_000, cat: AS, intent: 'neighborhood-mismatch',  target: 'SEED_BUYER_01' },
  { id: 'SEED_SALE_17', addr: '31-10 Ditmars Blvd', hood: 'Astoria',            beds: 2, price:  2_400_000, cat: CS, intent: 'neighborhood-mismatch',  target: 'SEED_BUYER_05' },
  { id: 'SEED_SALE_18', addr: '210 W 90th St',      hood: 'Upper West Side',    beds: 4, price:  3_000_000, cat: OM, intent: 'neighborhood-mismatch',  target: 'SEED_BUYER_04' },
  // 2 no-match (unusual specs — matches no seeded buyer)
  { id: 'SEED_SALE_19', addr: '4640 Fieldston Rd',  hood: 'Riverdale',          beds: 5, price:  4_000_000, cat: AS, intent: 'no-match',               target: '—' },
  { id: 'SEED_SALE_20', addr: '30 Park Pl PH',      hood: 'Financial District', beds: 4, price: 15_000_000, cat: OM, intent: 'no-match',               target: '—' },
]

// ── 20 rental listings (price == monthly rent) ───────────────────────────────
const RENTALS: Supply[] = [
  // 5 perfect
  { id: 'SEED_RENT_01', addr: '66 Perry St',        hood: 'West Village',       beds: 1, price:  3_800, cat: RL, intent: 'perfect',               target: 'SEED_RENTER_01' },
  { id: 'SEED_RENT_02', addr: '350 W 42nd St',      hood: 'Midtown',            beds: 0, price:  2_800, cat: RL, intent: 'perfect',               target: 'SEED_RENTER_02' },
  { id: 'SEED_RENT_03', addr: '175 Kent Ave',       hood: 'Williamsburg',       beds: 2, price:  5_000, cat: CR, intent: 'perfect',               target: 'SEED_RENTER_03' },
  { id: 'SEED_RENT_04', addr: '77 E 12th St',       hood: 'East Village',       beds: 1, price:  3_300, cat: RL, intent: 'perfect',               target: 'SEED_RENTER_04' },
  { id: 'SEED_RENT_05', addr: '101 W 79th St',      hood: 'Upper West Side',    beds: 3, price:  7_200, cat: CR, intent: 'perfect',               target: 'SEED_RENTER_05' },
  // 4 slight-over (RENT_06 == the brief's $4,050 vs $4,000 → ~0.75 example)
  { id: 'SEED_RENT_06', addr: '90 Bedford St',      hood: 'West Village',       beds: 1, price:  4_050, cat: RL, intent: 'slight-over',           target: 'SEED_RENTER_01' },
  { id: 'SEED_RENT_07', addr: '184 Kent Ave',       hood: 'Williamsburg',       beds: 2, price:  5_610, cat: CR, intent: 'slight-over',           target: 'SEED_RENTER_03' },
  { id: 'SEED_RENT_08', addr: '240 E 10th St',      hood: 'East Village',       beds: 1, price:  3_672, cat: RL, intent: 'slight-over',           target: 'SEED_RENTER_04' },
  { id: 'SEED_RENT_09', addr: '25-15 Astoria Blvd', hood: 'Astoria',            beds: 2, price:  4_080, cat: RL, intent: 'slight-over',           target: 'SEED_RENTER_06' },
  // 3 way-over
  { id: 'SEED_RENT_10', addr: '400 W 43rd St',      hood: 'Midtown',            beds: 0, price:  3_400, cat: RL, intent: 'way-over',              target: 'SEED_RENTER_02' },
  { id: 'SEED_RENT_11', addr: '210 W 89th St',      hood: 'Upper West Side',    beds: 3, price:  9_000, cat: CR, intent: 'way-over',              target: 'SEED_RENTER_05' },
  { id: 'SEED_RENT_12', addr: '300 7th Ave',        hood: 'Park Slope',         beds: 2, price:  5_400, cat: RL, intent: 'way-over',              target: 'SEED_RENTER_08' },
  // 3 slight-under
  { id: 'SEED_RENT_13', addr: '60 N 1st St',        hood: 'Williamsburg',       beds: 2, price:  4_275, cat: RL, intent: 'slight-under',          target: 'SEED_RENTER_03' },
  { id: 'SEED_RENT_14', addr: '55 W 81st St',       hood: 'Upper West Side',    beds: 3, price:  6_175, cat: CR, intent: 'slight-under',          target: 'SEED_RENTER_05' },
  { id: 'SEED_RENT_15', addr: '88 Ave A',           hood: 'East Village',       beds: 1, price:  2_850, cat: RL, intent: 'slight-under',          target: 'SEED_RENTER_04' },
  // 3 neighborhood-mismatch, rent-match
  { id: 'SEED_RENT_16', addr: '33-05 Broadway',     hood: 'Astoria',            beds: 1, price:  3_800, cat: RL, intent: 'neighborhood-mismatch', target: 'SEED_RENTER_01' },
  { id: 'SEED_RENT_17', addr: '145 W 96th St',      hood: 'Upper West Side',    beds: 2, price:  5_000, cat: CR, intent: 'neighborhood-mismatch', target: 'SEED_RENTER_03' },
  { id: 'SEED_RENT_18', addr: '88 Greenwich Ave',   hood: 'West Village',       beds: 2, price:  3_600, cat: RL, intent: 'neighborhood-mismatch', target: 'SEED_RENTER_06' },
  // 2 no-match
  { id: 'SEED_RENT_19', addr: '4640 Fieldston Rd',  hood: 'Riverdale',          beds: 4, price: 12_000, cat: RL, intent: 'no-match',              target: '—' },
  { id: 'SEED_RENT_20', addr: '30 Park Pl PH',      hood: 'Financial District', beds: 3, price: 15_000, cat: CR, intent: 'no-match',              target: '—' },
]

function demandRow(d: Demand, organizationId: string, buyer: boolean) {
  const kind = buyer ? 'buyer' : 'renter'
  const bedLabel = d.beds === 0 ? 'Studio' : `${d.beds}BR`
  return {
    id: d.id,
    rawEmailId: RAW_EMAIL_ID,
    organizationId,
    isTestData: true,
    category: buyer ? Category.BUYER_ISO : Category.RENTER_INQUIRY,
    transactionType: buyer ? TransactionType.BUYER_NEED : TransactionType.RENTER_NEED,
    neighborhood: d.hood,
    beds: d.beds,
    minPrice: d.min,
    maxPrice: d.max,
    price: null,
    extractedTitle: `${d.name} — ${kind} ISO, ${bedLabel} ${d.hood}`,
    extractedSummary: `SEED ${kind}: wants ${bedLabel} in ${d.hood}, budget $${d.min.toLocaleString()}–$${d.max.toLocaleString()}.`,
    classificationReason: `SEED demand (${kind})`,
    confidenceScore: 0.95,
  }
}

function supplyRow(s: Supply, organizationId: string, sale: boolean) {
  const bedLabel = s.beds === 0 ? 'Studio' : `${s.beds}BR`
  const unit = sale ? '' : '/mo'
  return {
    id: s.id,
    rawEmailId: RAW_EMAIL_ID,
    organizationId,
    isTestData: true,
    category: s.cat,
    transactionType: sale ? TransactionType.SALE : TransactionType.RENTAL,
    address: s.addr,
    neighborhood: s.hood,
    beds: s.beds,
    price: s.price,
    minPrice: null,
    maxPrice: null,
    extractedTitle: `${s.addr} — ${bedLabel} ${s.hood}`,
    extractedSummary: `SEED ${sale ? 'sale' : 'rental'} listing: ${s.addr}, ${bedLabel}, ${s.hood}, $${s.price.toLocaleString()}${unit}.`,
    classificationReason: `SEED ${sale ? 'sale' : 'rental'} (${s.intent} -> ${s.target})`,
    confidenceScore: 0.95,
  }
}

async function main() {
  const organizationId = await getCurrentOrgId()

  // Idempotent cleanup: matches referencing SEED opps, then SEED opps, then the
  // SEED parent email (FK order: match -> opportunity -> rawEmail).
  const delMatches = await prisma.match.deleteMany({
    where: { OR: [{ opportunityId: { startsWith: 'SEED_' } }, { counterpartId: { startsWith: 'SEED_' } }] },
  })
  const delOpps = await prisma.extractedOpportunity.deleteMany({ where: { id: { startsWith: 'SEED_' } } })
  const delEmails = await prisma.rawEmail.deleteMany({ where: { id: { startsWith: 'SEED_' } } })
  if (delMatches.count || delOpps.count || delEmails.count) {
    console.log(`Cleared prior SEED rows: ${delMatches.count} matches, ${delOpps.count} opps, ${delEmails.count} emails.`)
  }

  // Shared parent email — required by ExtractedOpportunity.rawEmailId FK.
  await prisma.rawEmail.create({
    data: {
      id: RAW_EMAIL_ID,
      graphMessageId: RAW_EMAIL_ID,
      organizationId,
      subject: 'Brief 2.5 seed test-data parent (not a real email)',
      senderName: 'DealFlow Seed',
      receivedDateTime: new Date(),
      processed: true,
    },
  })

  const rows = [
    ...BUYERS.map(b => demandRow(b, organizationId, true)),
    ...RENTERS.map(r => demandRow(r, organizationId, false)),
    ...SALES.map(s => supplyRow(s, organizationId, true)),
    ...RENTALS.map(r => supplyRow(r, organizationId, false)),
  ]
  const inserted = await prisma.extractedOpportunity.createMany({ data: rows })

  // Summary
  const buyers  = await prisma.extractedOpportunity.count({ where: { isTestData: true, category: Category.BUYER_ISO } })
  const renters = await prisma.extractedOpportunity.count({ where: { isTestData: true, category: Category.RENTER_INQUIRY } })
  const saleCats = [Category.COMING_SOON_SALE, Category.OFF_MARKET_SALE, Category.ACTIVE_SALE_LISTING]
  const rentCats = [Category.COMING_SOON_RENTAL, Category.RENTAL_LISTING]
  const sales   = await prisma.extractedOpportunity.count({ where: { isTestData: true, category: { in: saleCats } } })
  const rentals = await prisma.extractedOpportunity.count({ where: { isTestData: true, category: { in: rentCats } } })

  console.log(`\ncreateMany inserted ${inserted.count} rows.`)
  console.log(`Inserted ${buyers} buyers, ${renters} renters, ${sales} sale listings, ${rentals} rental listings. All tagged isTestData=true (schema has no emailSource column; SEED_ id prefix + isTestData is the test tag).`)

  // Distribution coverage (by intent, parsed from classificationReason)
  const all = await prisma.extractedOpportunity.findMany({
    where: { isTestData: true, category: { in: [...saleCats, ...rentCats] } },
    select: { classificationReason: true },
  })
  const dist: Record<string, number> = {}
  for (const o of all) {
    const m = o.classificationReason.match(/\((.+?) ->/)
    const intent = m ? m[1] : 'unknown'
    dist[intent] = (dist[intent] ?? 0) + 1
  }
  console.log('\nListing distribution (sale + rental combined):')
  console.table(dist)

  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })

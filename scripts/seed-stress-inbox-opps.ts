// Brief 10.0 — Part B/C/D: ~500 inbox opportunities across ALL 18 categories,
// with deliberate match density (Part C) and realistic extraction gaps (Part D).
//
// Direct Prisma inserts into the app org (dealflow-ryan). All rows isTestData=true,
// extractedTitle prefixed [TEST_10], sourceAgentEmail on the sentinel domain.
// Embeddings generated for every row. Then the REAL matching engine is invoked on
// the deliberate HOT/SE/near-miss/sparse listings to warm the Match table (this is
// the only Sonnet spend — the notes-parser/geocoder are NOT run).
//
// Run:   npx tsx scripts/seed-stress-inbox-opps.ts
// Wipe:  npx tsx scripts/seed-stress-cleanup.ts
import 'dotenv/config' // MUST be first — lib/prisma builds its pg Pool from
                       // DATABASE_URL at import time; loading env any later makes
                       // the Pool default to localhost:5432 (ECONNREFUSED).
import { Category, MatchTier } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { findMatchesForListing } from '../lib/matching/engine'
import { MatchingCostAbort } from '../lib/matching/cost'
import {
  TAG, SEED_DOMAIN, getOrgAndAnchor, ensureConnected, retryDb, makeRng, HOODS, HOOD_BY_NAME, ADJACENT_PAIRS,
  BROKERAGES, SE_BROKERAGE, txForCategory, roundPrice, roundRent, embedOpp,
  brokerName, emailFrom, streetAddress, type Hood,
} from './seed-stress-common'
import { refuseLiveDatabase } from '../lib/dbGuard'

// Brief 41.2 (engineering precaution): test or seed data only, so it refuses
// any database but a *_perf or *_test one, with no override.
refuseLiveDatabase(process.env.DATABASE_URL, 'scripts/seed-stress-inbox-opps.ts (DATABASE_URL)')

process.env.MATCHING_MAX_CANDIDATES ??= '8' // bound each warm query's Sonnet fan-out
const WARM_BUDGET_USD = 2.0
const WARM_WALLCLOCK_MS = 5 * 60_000 // hard wall-clock cap on the warm phase

// Category distribution (Part B) — sums to 505.
const DISTRIBUTION: [Category, number][] = [
  [Category.COMING_SOON_SALE, 60], [Category.COMING_SOON_RENTAL, 30], [Category.OFF_MARKET_SALE, 40],
  [Category.ACTIVE_SALE_LISTING, 60], [Category.RENTAL_LISTING, 40], [Category.BUYER_ISO, 60],
  [Category.RENTER_INQUIRY, 30], [Category.SELLER_LEAD, 25], [Category.LANDLORD_LEAD, 15],
  [Category.DEVELOPMENT_INVENTORY, 20], [Category.COMING_SOON_DEVELOPMENT, 15], [Category.SPONSOR_UNIT, 15],
  [Category.OPEN_HOUSE, 15], [Category.PRICE_DROP, 20], [Category.BACK_ON_MARKET, 10],
  [Category.MARKET_REPORT, 15], [Category.REAL_ESTATE_EVENT, 10], [Category.CLIENT_CONVERSATION, 10],
  [Category.SHOWING_CONFIRMATION, 5], [Category.NOISE, 10],
]

type Rng = ReturnType<typeof makeRng>

async function main() {
  await ensureConnected()
  const existing = await prisma.extractedOpportunity.count({ where: { extractedTitle: { startsWith: `${TAG} ` } } })
  if (existing > 0) {
    console.log(`${existing} ${TAG} opportunities already exist — skipping insert. Run cleanup for a fresh seed.`)
    await prisma.$disconnect(); return
  }

  const { orgId, rawEmailId } = await getOrgAndAnchor()
  const rng = makeRng(0x10B0)

  const made: Partial<Record<Category, number>> = {}
  const bump = (c: Category) => { made[c] = (made[c] ?? 0) + 1 }
  const embedJobs: { id: string; text: Parameters<typeof embedOpp>[1] }[] = []

  // ── createOpp: single insert helper. Returns the new id. ────────────────────
  async function createOpp(fields: {
    category: Category
    title: string; summary: string; reason: string; confidence: number
    address?: string | null; neighborhood?: string | null; borough?: string | null
    price?: number | null; minPrice?: number | null; maxPrice?: number | null
    beds?: number | null; propertyType?: string | null; units?: number | null
    availabilityDate?: string | null
    // demand-party fields
    minBeds?: number | null; maxBeds?: number | null; neighborhoods?: string[]
    mustHaves?: string | null; timeline?: string | null
    sourceAgentName?: string | null; sourceBrokerage?: string | null
    createdAt: Date
  }): Promise<string> {
    const agentName = fields.sourceAgentName === undefined ? brokerName(rng) : fields.sourceAgentName
    const row = await retryDb(() => prisma.extractedOpportunity.create({
      data: {
        organizationId: orgId, rawEmailId, isTestData: true,
        category: fields.category, transactionType: txForCategory(fields.category),
        extractedTitle: fields.title, extractedSummary: fields.summary,
        classificationReason: fields.reason, confidenceScore: fields.confidence,
        address: fields.address ?? null, neighborhood: fields.neighborhood ?? null, borough: fields.borough ?? null,
        city: fields.neighborhood || fields.address ? 'New York' : null,
        price: fields.price ?? null, minPrice: fields.minPrice ?? null, maxPrice: fields.maxPrice ?? null,
        beds: fields.beds ?? null, propertyType: fields.propertyType ?? null, units: fields.units ?? null,
        availabilityDate: fields.availabilityDate ?? null,
        minBeds: fields.minBeds ?? null, maxBeds: fields.maxBeds ?? null,
        neighborhoods: fields.neighborhoods ?? [],
        mustHaves: fields.mustHaves ?? null, timeline: fields.timeline ?? null,
        sourceAgentName: agentName,
        sourceAgentEmail: agentName ? emailFrom(agentName) : `anon@${SEED_DOMAIN}`,
        sourceBrokerage: fields.sourceBrokerage === undefined ? rng.weighted(BROKERAGES) : fields.sourceBrokerage,
        createdAt: fields.createdAt,
      },
      select: { id: true },
    }))
    bump(fields.category)
    embedJobs.push({
      id: row.id,
      text: {
        extractedTitle: fields.title, extractedSummary: fields.summary, category: fields.category,
        neighborhood: fields.neighborhood ?? null, borough: fields.borough ?? null, address: fields.address ?? null,
        propertyType: fields.propertyType ?? null, beds: fields.beds ?? null, units: fields.units ?? null,
        price: fields.price ?? null, minPrice: fields.minPrice ?? null, maxPrice: fields.maxPrice ?? null,
        sourceBrokerage: fields.sourceBrokerage ?? null, sourceAgentName: agentName,
        availabilityDate: fields.availabilityDate ?? null,
      },
    })
    return row.id
  }

  const recent = (maxDays: number) => new Date(Date.now() - rng.int(0, maxDays) * 86_400_000 - rng.int(0, 23) * 3_600_000)
  const fresh = () => new Date(Date.now() - rng.int(1, 4) * 86_400_000) // <7d → HOT-eligible
  const conf = (lo = 0.7, hi = 1.0) => Math.round((lo + rng.next() * (hi - lo)) * 100) / 100
  const bedsFor = (rng2: Rng) => rng2.weighted<number>([[0, 1], [1, 3], [2, 4], [3, 3], [4, 1]])
  const salePrice = (h: Hood, beds: number) => roundPrice(h.basePrice * (0.55 + 0.28 * Math.max(1, beds)) * (0.9 + rng.next() * 0.25))
  const rentPrice = (h: Hood, beds: number) => roundRent(h.rentBase * (0.6 + 0.25 * Math.max(1, beds)) * (0.9 + rng.next() * 0.2))
  const propType = () => rng.weighted<string>([['CONDO', 5], ['COOP', 3], ['TOWNHOUSE', 1]])

  // ══ PART C — deliberate match density ═════════════════════════════════════════
  const warmTargets: { id: string; label: string }[] = []
  const hotHoods = [...HOODS].slice(0, 12) // 12 distinct hoods for HOT pairs

  console.log('Part C — constructing deliberate match pairs…')

  // 12 obvious HOT pairs
  for (const h of hotHoods) {
    const beds = rng.weighted<number>([[2, 3], [3, 2], [1, 1]])
    const p = salePrice(h, beds)
    await createOpp({
      category: Category.BUYER_ISO, title: `${TAG} Buyer ISO — ${beds}BR ${h.name}`,
      summary: `Qualified buyer seeking a ${beds}BR in ${h.name}, budget centered near $${(p / 1_000_000).toFixed(2)}M. Ready to move.`,
      reason: 'Buyer demand with explicit neighborhood, beds, and budget → BUYER_ISO.', confidence: conf(0.85, 1.0),
      neighborhoods: [h.name], neighborhood: h.name, borough: h.borough,
      minBeds: beds, maxBeds: beds, minPrice: roundPrice(p * 0.92), maxPrice: roundPrice(p * 1.08),
      timeline: rng.pick(['now', '3 months']), mustHaves: rng.chance(0.3) ? 'cash only' : null,
      sourceBrokerage: rng.weighted(BROKERAGES), createdAt: fresh(),
    })
    const lid = await createOpp({
      category: Category.COMING_SOON_SALE, title: `${TAG} Coming Soon — ${beds}BR ${h.name}`,
      summary: `Coming-soon ${beds}BR ${propType().toLowerCase()} in ${h.name}, asking $${(p / 1_000_000).toFixed(2)}M. Hits market next week.`,
      reason: 'Pre-market sale inventory with price + address → COMING_SOON_SALE.', confidence: conf(0.85, 1.0),
      address: streetAddress(rng), neighborhood: h.name, borough: h.borough,
      price: p, beds, propertyType: propType(), createdAt: fresh(),
    })
    warmTargets.push({ id: lid, label: `HOT ${h.name}` })
  }

  // 10 near-misses (5 price-off exact-hood; 5 adjacent-hood price-fits) → WARM/POSSIBLE
  for (let i = 0; i < 5; i++) {
    const h = rng.pick(HOODS); const beds = 2
    const p = salePrice(h, beds)
    await createOpp({
      category: Category.BUYER_ISO, title: `${TAG} Buyer ISO — ${beds}BR ${h.name} (tight budget)`,
      summary: `Buyer wants ${beds}BR in ${h.name} but budget runs ~25% under current ask.`,
      reason: 'Neighborhood + beds explicit, budget below market → BUYER_ISO.', confidence: conf(0.8, 0.95),
      neighborhoods: [h.name], neighborhood: h.name, borough: h.borough,
      minBeds: beds, maxBeds: beds, minPrice: roundPrice(p * 0.68), maxPrice: roundPrice(p * 0.75),
      timeline: '6 months', sourceBrokerage: rng.weighted(BROKERAGES), createdAt: fresh(),
    })
    const lid = await createOpp({
      category: Category.ACTIVE_SALE_LISTING, title: `${TAG} Active — ${beds}BR ${h.name}`,
      summary: `On-market ${beds}BR in ${h.name}, asking $${(p / 1_000_000).toFixed(2)}M.`,
      reason: 'Live on-market sale listing → ACTIVE_SALE_LISTING.', confidence: conf(0.8, 1.0),
      address: streetAddress(rng), neighborhood: h.name, borough: h.borough, price: p, beds,
      propertyType: propType(), createdAt: fresh(),
    })
    warmTargets.push({ id: lid, label: `near-price ${h.name}` })
  }
  for (const [a, b] of ADJACENT_PAIRS.slice(0, 5)) {
    const ha = HOOD_BY_NAME[a], hb = HOOD_BY_NAME[b]; const beds = 2
    const p = salePrice(hb, beds)
    await createOpp({
      category: Category.BUYER_ISO, title: `${TAG} Buyer ISO — ${beds}BR ${a}`,
      summary: `Buyer focused on ${a}, ${beds}BR, budget ~$${(p / 1_000_000).toFixed(2)}M.`,
      reason: 'Neighborhood + beds + budget → BUYER_ISO.', confidence: conf(0.8, 1.0),
      neighborhoods: [a], neighborhood: a, borough: ha.borough,
      minBeds: beds, maxBeds: beds, minPrice: roundPrice(p * 0.9), maxPrice: roundPrice(p * 1.1),
      timeline: '3 months', sourceBrokerage: rng.weighted(BROKERAGES), createdAt: fresh(),
    })
    const lid = await createOpp({
      category: Category.ACTIVE_SALE_LISTING, title: `${TAG} Active — ${beds}BR ${b}`,
      summary: `On-market ${beds}BR in ${b} (borders ${a}), asking $${(p / 1_000_000).toFixed(2)}M.`,
      reason: 'Live on-market sale listing → ACTIVE_SALE_LISTING.', confidence: conf(0.8, 1.0),
      address: streetAddress(rng), neighborhood: b, borough: hb.borough, price: p, beds,
      propertyType: propType(), createdAt: fresh(),
    })
    warmTargets.push({ id: lid, label: `adjacent ${a}~${b}` })
  }

  // 8 sparse-but-should-match (buyer has only hood + budget, no beds)
  for (let i = 0; i < 8; i++) {
    const h = rng.pick(HOODS); const beds = rng.weighted<number>([[2, 3], [3, 2]])
    const p = salePrice(h, beds)
    await createOpp({
      category: Category.BUYER_ISO, title: `${TAG} Buyer ISO — ${h.name} (beds open)`,
      summary: `Buyer active in ${h.name}, budget to $${(p * 1.1 / 1_000_000).toFixed(2)}M; bedroom count flexible.`,
      reason: 'Neighborhood + budget explicit, beds unspecified → BUYER_ISO.', confidence: conf(0.7, 0.9),
      neighborhoods: [h.name], neighborhood: h.name, borough: h.borough,
      minBeds: null, maxBeds: null, minPrice: roundPrice(p * 0.9), maxPrice: roundPrice(p * 1.12),
      timeline: rng.pick(['now', '3 months']), sourceBrokerage: rng.weighted(BROKERAGES), createdAt: fresh(),
    })
    const lid = await createOpp({
      category: Category.COMING_SOON_SALE, title: `${TAG} Coming Soon — ${beds}BR ${h.name}`,
      summary: `Coming-soon ${beds}BR in ${h.name}, asking $${(p / 1_000_000).toFixed(2)}M.`,
      reason: 'Pre-market sale inventory → COMING_SOON_SALE.', confidence: conf(0.8, 1.0),
      address: streetAddress(rng), neighborhood: h.name, borough: h.borough, price: p, beds,
      propertyType: propType(), createdAt: fresh(),
    })
    warmTargets.push({ id: lid, label: `sparse ${h.name}` })
  }

  // 5 SE-priority pairs (buyer flagged StreetEasy Experts → ⭐ SE badge + rank boost)
  for (let i = 0; i < 5; i++) {
    const h = hotHoods[i]; const beds = rng.weighted<number>([[2, 3], [3, 2]])
    const p = salePrice(h, beds)
    await createOpp({
      category: Category.BUYER_ISO, title: `${TAG} SE Buyer ISO — ${beds}BR ${h.name}`,
      summary: `StreetEasy-sourced buyer, ${beds}BR ${h.name}, budget near $${(p / 1_000_000).toFixed(2)}M.`,
      reason: 'StreetEasy Expert buyer demand → BUYER_ISO (SE priority).', confidence: conf(0.85, 1.0),
      neighborhoods: [h.name], neighborhood: h.name, borough: h.borough,
      minBeds: beds, maxBeds: beds, minPrice: roundPrice(p * 0.92), maxPrice: roundPrice(p * 1.08),
      timeline: 'now', sourceBrokerage: SE_BROKERAGE, createdAt: fresh(),
    })
    const lid = await createOpp({
      category: Category.COMING_SOON_SALE, title: `${TAG} Coming Soon — ${beds}BR ${h.name} (SE match)`,
      summary: `Coming-soon ${beds}BR in ${h.name}, asking $${(p / 1_000_000).toFixed(2)}M.`,
      reason: 'Pre-market sale inventory → COMING_SOON_SALE.', confidence: conf(0.85, 1.0),
      address: streetAddress(rng), neighborhood: h.name, borough: h.borough, price: p, beds,
      propertyType: propType(), createdAt: fresh(),
    })
    warmTargets.push({ id: lid, label: `SE ${h.name}` })
  }

  // 3 SHOWING_CONFIRMATION self-matches (opportunityId === counterpartId)
  const showingIds: string[] = []
  for (let i = 0; i < 3; i++) {
    const h = rng.pick(HOODS); const addr = streetAddress(rng)
    const date = new Date(Date.now() + rng.int(1, 6) * 86_400_000).toISOString().slice(0, 10)
    const id = await createOpp({
      category: Category.SHOWING_CONFIRMATION, title: `${TAG} Showing confirmed — ${addr}`,
      summary: `Showing confirmed for ${addr}, ${h.name} on ${date}. Buyer + co-broker attending.`,
      reason: 'Confirmed showing appointment with address + date → SHOWING_CONFIRMATION.', confidence: conf(0.85, 1.0),
      address: addr, neighborhood: h.name, borough: h.borough, availabilityDate: date, createdAt: fresh(),
    })
    showingIds.push(id)
  }

  console.log(`  Part C rows created. Warm targets: ${warmTargets.length}, showings: ${showingIds.length}`)

  // ══ PART B + D — bulk fill each category to its target, with ~20% holes ═══════
  console.log('Part B/D — filling category distribution…')
  for (const [cat, target] of DISTRIBUTION) {
    const need = target - (made[cat] ?? 0)
    for (let i = 0; i < need; i++) await bulkOpp(cat)
  }

  async function bulkOpp(cat: Category): Promise<void> {
    const h = rng.pick(HOODS)
    const beds = bedsFor(rng)
    const hole = rng.chance(0.2) // Part D — deliberate extraction gap
    const c = hole && rng.chance(0.4) ? conf(0.55, 0.7) : conf(0.72, 1.0)
    const created = recent(30)
    const holeKind = hole ? rng.pick(['price', 'beds', 'hood', 'address', 'agent']) : null
    const A = () => holeKind === 'address' ? null : streetAddress(rng)
    const N = () => holeKind === 'hood' ? null : h.name
    const B = () => holeKind === 'hood' ? null : h.borough
    const agent = () => holeKind === 'agent' ? null : brokerName(rng)

    switch (cat) {
      case Category.COMING_SOON_SALE:
      case Category.OFF_MARKET_SALE:
      case Category.ACTIVE_SALE_LISTING:
      case Category.BACK_ON_MARKET: {
        const p = holeKind === 'price' ? null : salePrice(h, beds)
        const label = cat === Category.OFF_MARKET_SALE ? 'Off-market' : cat === Category.BACK_ON_MARKET ? 'Back on market' : cat === Category.COMING_SOON_SALE ? 'Coming soon' : 'Active'
        await createOpp({
          category: cat, title: `${TAG} ${label} — ${beds}BR ${h.name}`,
          summary: `${label} ${beds}BR ${propType().toLowerCase()} in ${h.name}${p ? `, asking $${(p / 1_000_000).toFixed(2)}M` : ' (price on request)'}.`,
          reason: `${label} sale inventory → ${cat}.`, confidence: c,
          address: A(), neighborhood: N(), borough: B(),
          price: p, beds: holeKind === 'beds' ? null : beds, propertyType: propType(),
          sourceAgentName: agent(), createdAt: created,
        })
        return
      }
      case Category.PRICE_DROP: {
        const p = salePrice(h, beds); const was = roundPrice(p * 1.15)
        await createOpp({
          category: cat, title: `${TAG} Price drop — ${beds}BR ${h.name}`,
          summary: `Reduced from $${(was / 1_000_000).toFixed(2)}M to $${(p / 1_000_000).toFixed(2)}M — ${beds}BR in ${h.name}.`,
          reason: 'Explicit price reduction on a sale listing → PRICE_DROP.', confidence: c,
          address: A(), neighborhood: N(), borough: B(), price: p, minPrice: p, maxPrice: was,
          beds, propertyType: propType(), createdAt: created,
        })
        return
      }
      case Category.RENTAL_LISTING:
      case Category.COMING_SOON_RENTAL: {
        const r = holeKind === 'price' ? null : rentPrice(h, beds)
        const label = cat === Category.COMING_SOON_RENTAL ? 'Coming-soon rental' : 'Rental'
        const avail = new Date(Date.now() + rng.int(7, 60) * 86_400_000).toISOString().slice(0, 10)
        await createOpp({
          category: cat, title: `${TAG} ${label} — ${beds}BR ${h.name}`,
          summary: `${label} ${beds}BR in ${h.name}${r ? `, $${r.toLocaleString()}/mo` : ''}, available ${avail}.`,
          reason: `${label} inventory → ${cat}.`, confidence: c,
          address: A(), neighborhood: N(), borough: B(), price: r,
          beds: holeKind === 'beds' ? null : beds, propertyType: 'RENTAL', availabilityDate: avail,
          sourceAgentName: agent(), createdAt: created,
        })
        return
      }
      case Category.BUYER_ISO: {
        const tier = rng.weighted<string>([['mid', 4], ['luxury', 3], ['starter', 2], ['ultra', 1]])
        const p = salePrice(h, beds)
        const lo = tier === 'starter' ? 500_000 : tier === 'mid' ? 1_000_000 : tier === 'luxury' ? 3_000_000 : 8_000_000
        await createOpp({
          category: cat, title: `${TAG} Buyer ISO — ${beds}BR ${h.name}`,
          summary: `Buyer seeking ${beds}BR in ${h.name}, budget to $${(Math.max(p, lo) * 1.1 / 1_000_000).toFixed(2)}M.`,
          reason: 'Buyer demand with neighborhood + beds + budget → BUYER_ISO.', confidence: c,
          neighborhoods: holeKind === 'hood' ? [] : [h.name], neighborhood: N(), borough: B(),
          minBeds: holeKind === 'beds' ? null : beds, maxBeds: holeKind === 'beds' ? null : beds,
          minPrice: roundPrice(Math.max(p, lo) * 0.85), maxPrice: roundPrice(Math.max(p, lo) * 1.1),
          timeline: rng.pick(['now', '3 months', '6 months', 'flexible']),
          mustHaves: rng.chance(0.25) ? 'cash only' : null, createdAt: created,
        })
        return
      }
      case Category.RENTER_INQUIRY: {
        const r = rentPrice(h, beds)
        await createOpp({
          category: cat, title: `${TAG} Renter inquiry — ${beds}BR ${h.name}`,
          summary: `Renter seeking ${beds}BR in ${h.name}, budget ~$${r.toLocaleString()}/mo.`,
          reason: 'Renter demand with neighborhood + beds + budget → RENTER_INQUIRY.', confidence: c,
          neighborhoods: holeKind === 'hood' ? [] : [h.name], neighborhood: N(), borough: B(),
          minBeds: holeKind === 'beds' ? null : beds, maxBeds: holeKind === 'beds' ? null : beds,
          minPrice: roundRent(r * 0.85), maxPrice: roundRent(r * 1.15),
          timeline: rng.pick(['now', '3 months', 'flexible']), createdAt: created,
        })
        return
      }
      case Category.SELLER_LEAD: {
        const p = salePrice(h, beds)
        await createOpp({
          category: cat, title: `${TAG} Seller lead — ${h.name}`,
          summary: `Owner in ${h.name} considering listing a ${beds}BR, est. value ~$${(p / 1_000_000).toFixed(2)}M.`,
          reason: 'Owner weighing a sale → SELLER_LEAD.', confidence: c,
          address: A(), neighborhood: N(), borough: B(), price: p, beds, propertyType: propType(),
          sourceAgentName: agent(), createdAt: created,
        })
        return
      }
      case Category.LANDLORD_LEAD: {
        const r = rentPrice(h, beds)
        await createOpp({
          category: cat, title: `${TAG} Landlord lead — ${h.name}`,
          summary: `Landlord in ${h.name} with a ${beds}BR unit potentially available, ~$${r.toLocaleString()}/mo.`,
          reason: 'Owner with a rentable unit → LANDLORD_LEAD.', confidence: c,
          address: A(), neighborhood: N(), borough: B(), price: r, beds, propertyType: 'RENTAL',
          sourceAgentName: agent(), createdAt: created,
        })
        return
      }
      case Category.DEVELOPMENT_INVENTORY:
      case Category.COMING_SOON_DEVELOPMENT:
      case Category.SPONSOR_UNIT: {
        const units = cat === Category.SPONSOR_UNIT ? rng.int(1, 6) : rng.int(12, 220)
        const lo = salePrice(h, 1), hi = roundPrice(salePrice(h, 3) * 1.4)
        const label = cat === Category.SPONSOR_UNIT ? 'Sponsor units' : cat === Category.COMING_SOON_DEVELOPMENT ? 'Coming-soon development' : 'Development inventory'
        await createOpp({
          category: cat, title: `${TAG} ${label} — ${h.name}`,
          summary: `${label} in ${h.name}: ${units} ${cat === Category.SPONSOR_UNIT ? 'sponsor units' : 'residences'}, $${(lo / 1_000_000).toFixed(1)}M–$${(hi / 1_000_000).toFixed(1)}M.`,
          reason: `New-development offering → ${cat}.`, confidence: c,
          address: A(), neighborhood: N(), borough: B(), minPrice: lo, maxPrice: hi,
          units, propertyType: 'CONDO', sourceAgentName: agent(), createdAt: created,
        })
        return
      }
      case Category.OPEN_HOUSE: {
        const p = salePrice(h, beds); const addr = streetAddress(rng)
        const date = new Date(Date.now() + rng.int(1, 10) * 86_400_000).toISOString().slice(0, 10)
        await createOpp({
          category: cat, title: `${TAG} Open house — ${addr}`,
          summary: `Open house at ${addr}, ${h.name} on ${date}, ${beds}BR asking $${(p / 1_000_000).toFixed(2)}M.`,
          reason: 'Scheduled open house for a listing → OPEN_HOUSE.', confidence: c,
          address: addr, neighborhood: N(), borough: B(), price: p, beds, availabilityDate: date, createdAt: created,
        })
        return
      }
      case Category.MARKET_REPORT: {
        await createOpp({
          category: cat, title: `${TAG} Market report — ${h.name} Q2 2026`,
          summary: `Quarterly market snapshot for ${h.name}: median price, inventory, and days-on-market trends.`,
          reason: 'Aggregate market data, not a specific listing → MARKET_REPORT.', confidence: c,
          neighborhood: h.name, borough: h.borough, createdAt: created,
        })
        return
      }
      case Category.REAL_ESTATE_EVENT: {
        const date = new Date(Date.now() + rng.int(3, 30) * 86_400_000).toISOString().slice(0, 10)
        await createOpp({
          category: cat, title: `${TAG} Broker event — ${h.name} mixer`,
          summary: `Networking mixer for agents in ${h.name} on ${date}.`,
          reason: 'Industry event invitation → REAL_ESTATE_EVENT.', confidence: c,
          neighborhood: h.name, borough: h.borough, availabilityDate: date, createdAt: created,
        })
        return
      }
      case Category.CLIENT_CONVERSATION: {
        await createOpp({
          category: cat, title: `${TAG} Client call notes — ${brokerName(rng)}`,
          summary: `Notes from a client conversation about timing and neighborhood preferences (${h.name}).`,
          reason: 'Free-form client conversation, no structured listing → CLIENT_CONVERSATION.', confidence: c,
          neighborhood: rng.chance(0.5) ? h.name : null, createdAt: created,
        })
        return
      }
      case Category.SHOWING_CONFIRMATION: {
        const addr = streetAddress(rng)
        const date = new Date(Date.now() + rng.int(1, 6) * 86_400_000).toISOString().slice(0, 10)
        await createOpp({
          category: cat, title: `${TAG} Showing confirmed — ${addr}`,
          summary: `Showing confirmed at ${addr}, ${h.name} on ${date}.`,
          reason: 'Confirmed showing appointment → SHOWING_CONFIRMATION.', confidence: c,
          address: addr, neighborhood: h.name, borough: h.borough, availabilityDate: date, createdAt: created,
        })
        return
      }
      case Category.NOISE: {
        const kinds = ['Newsletter: 10 productivity tips', 'Your Amazon order has shipped', 'Team lunch Friday?',
          'Invoice #4821 from the print shop', 'Weekend weather alert', 'Your subscription renews soon']
        const t = rng.pick(kinds)
        await createOpp({
          category: cat, title: `${TAG} ${t}`,
          summary: `Non-real-estate email (${t.toLowerCase()}) — classifier robustness check.`,
          reason: 'No real estate content → NOISE.', confidence: c,
          sourceAgentName: null, createdAt: created,
        })
        return
      }
      default:
        return
    }
  }

  // ── Embeddings for every opp ────────────────────────────────────────────────
  console.log(`Generating embeddings for ${embedJobs.length} opps…`)
  let done = 0
  await pooled(embedJobs, 8, async (j) => { await retryDb(() => embedOpp(j.id, j.text)); if (++done % 100 === 0) console.log(`  embedded ${done}/${embedJobs.length}`) })

  const TIER_SCORE: Record<'Hot' | 'Warm' | 'Possible', number> = { Hot: 90, Warm: 70, Possible: 50 }
  const TIER_ENUM: Record<'Hot' | 'Warm' | 'Possible', MatchTier> = { Hot: MatchTier.HOT, Warm: MatchTier.WARM, Possible: MatchTier.POSSIBLE }
  let spend = 0, written = 0, hot = 0
  const tierCounts: Record<string, number> = { HOT: 0, WARM: 0, POSSIBLE: 0 }

  // Showing-confirmation self-matches FIRST (cheap, no LLM) so they always land
  // even if the warm phase hits its wall-clock/$ budget.
  for (const sid of showingIds) {
    const o = await retryDb(() => prisma.extractedOpportunity.findUnique({ where: { id: sid }, select: { extractedTitle: true, address: true, availabilityDate: true } }))
    const reason = `Showing confirmation: ${o?.extractedTitle}${o?.address ? ' at ' + o.address : ''}${o?.availabilityDate ? ' on ' + o.availabilityDate : ''}. Add to your Outlook calendar?`
    await retryDb(() => prisma.match.upsert({
      where: { opportunityId_counterpartId_counterpartType: { opportunityId: sid, counterpartId: sid, counterpartType: 'showing_confirmation' } },
      create: { organizationId: orgId, opportunityId: sid, counterpartId: sid, counterpartType: 'showing_confirmation', score: 90, reason },
      update: { score: 90, reason },
    }))
    written++
  }

  // ── Warm the matcher on the deliberate targets (the only Sonnet spend) ──────
  // Priority order: HOT pairs → SE pairs → the rest, so the gate-critical pairs
  // are always covered before the $ / wall-clock budget bites.
  const priority = (label: string) => label.startsWith('HOT') ? 0 : label.startsWith('SE') ? 1 : 2
  warmTargets.sort((a, b) => priority(a.label) - priority(b.label))
  console.log(`\nWarming matcher on ${warmTargets.length} deliberate targets (HOT+SE first)…`)
  const warmStart = Date.now()
  for (const t of warmTargets) {
    if (spend >= WARM_BUDGET_USD) { console.log(`  ⛔ warm $ budget reached (spent $${spend.toFixed(4)}) — stopping.`); break }
    if (Date.now() - warmStart > WARM_WALLCLOCK_MS) { console.log(`  ⛔ warm wall-clock cap reached — stopping (HOT+SE already covered).`); break }
    try {
      const res = await retryDb(() => findMatchesForListing(t.id, { limit: 25 }))
      spend += res.costUSD
      for (const m of res.results) {
        await retryDb(() => prisma.match.upsert({
          where: { opportunityId_counterpartId_counterpartType: { opportunityId: t.id, counterpartId: m.party.id, counterpartType: 'opportunity' } },
          create: { organizationId: orgId, opportunityId: t.id, counterpartId: m.party.id, counterpartType: 'opportunity', score: TIER_SCORE[m.tier], tier: TIER_ENUM[m.tier], reason: m.reason },
          update: { score: TIER_SCORE[m.tier], tier: TIER_ENUM[m.tier], reason: m.reason },
        }))
        written++; tierCounts[m.tier.toUpperCase()]++; if (m.tier === 'Hot') hot++
      }
      console.log(`  ✓ ${t.label.padEnd(24)} ${res.results.length} match(es)  Σ$${spend.toFixed(4)}`)
    } catch (e) {
      if (e instanceof MatchingCostAbort) { spend = e.runningCostUsd; console.log(`  ⚠︎ cost kill-switch on ${t.label} — ${e.message}`); break }
      console.log(`  ⚠︎ ${t.label}: ${(e as Error).message}`)
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  const totalOpps = await retryDb(() => prisma.extractedOpportunity.count({ where: { extractedTitle: { startsWith: `${TAG} ` } } }))
  const byCat = await retryDb(() => prisma.extractedOpportunity.groupBy({ by: ['category'], where: { extractedTitle: { startsWith: `${TAG} ` } }, _count: { _all: true } }))
  console.log('\n' + '═'.repeat(64))
  console.log(`SEEDED OPPS:        ${totalOpps} (${byCat.length} categories)`)
  console.log(`MATCHES WRITTEN:    ${written}  (HOT ${tierCounts.HOT} · WARM ${tierCounts.WARM} · POSSIBLE ${tierCounts.POSSIBLE} · showings ${showingIds.length})`)
  console.log(`HOT PAIRS:          ${hot}`)
  console.log(`WARM SONNET SPEND:  $${spend.toFixed(4)}`)
  console.log('═'.repeat(64))
  console.table(byCat.map(r => ({ category: r.category, count: r._count._all })).sort((a, b) => a.category.localeCompare(b.category)))
  await prisma.$disconnect()
}

async function pooled<T>(items: T[], size: number, fn: (t: T, i: number) => Promise<void>): Promise<void> {
  let idx = 0
  async function worker() { while (idx < items.length) { const i = idx++; await fn(items[i], i) } }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })

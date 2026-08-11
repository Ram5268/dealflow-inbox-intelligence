// Brief 10.0 — shared helpers for the stress-test seed (Mojo buyers + inbox opps).
//
// Everything here writes into the SINGLETON app org `dealflow-ryan`
// (the org getCurrentOrgId() resolves to — what the deployed PWA reads), so the
// seeds are visible when Ryan dogfoods. All rows are isTestData=true and carry a
// human-visible [TEST_10] prefix + a sentinel so cleanup is a single WHERE clause.
//
// NOTE: no live Graph/Zapier, no Sonnet notes-parser, no geocoder here. Parsed
// fields (beds/budget/neighborhood) are populated DIRECTLY — this file IS the
// seed source-of-truth. The only LLM spend is (a) OpenAI embeddings and (b) the
// matcher's Sonnet tiering during the deliberate warm step in the opps script.
import 'dotenv/config'
import { Category, TransactionType } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { buildOpportunityText, embedText, upsertOpportunityEmbedding } from '../lib/embeddings'

export const TAG = '[TEST_10]'
export const SEED_DOMAIN = 'seed-test-10.dealflow.local' // sentinel sourceAgentEmail domain
export const ORG_SLUG = 'dealflow-ryan'

// ── Connection warm-up ────────────────────────────────────────────────────────
// The DB sits behind a Railway TCP proxy that intermittently refuses the FIRST
// connection (ECONNREFUSED). Once a pool connection is live it's stable, so ping
// SELECT 1 with backoff before any real work.
export async function ensureConnected(retries = 40): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try { await prisma.$queryRaw`SELECT 1`; if (i > 0) console.log('  db connection established.'); return }
    catch (e) {
      const code = (e as { code?: string }).code
      if (code !== 'ECONNREFUSED' && code !== 'ETIMEDOUT' && code !== 'ECONNRESET' && i >= 2) throw e
      const wait = Math.min(8000, 1000 + i * 500) // cap backoff so a degraded proxy is ridden through
      if (i % 5 === 0) console.log(`  db not ready (${code ?? 'err'}), retry ${i + 1}/${retries} in ${wait}ms… (Railway may be degraded)`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
  throw new Error('Could not establish a DB connection after retries — Railway likely still degraded; rerun when it recovers.')
}

// Retry a single DB op through a transient proxy refusal (Railway is bursty).
// Only connection-class errors are retried; logic errors + MatchingCostAbort
// rethrow immediately so real bugs surface fast.
const CONN_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'P1001', 'P1002', 'P1017'])
export async function retryDb<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < tries; i++) {
    try { return await fn() }
    catch (e) {
      const code = (e as { code?: string }).code
      if (!code || !CONN_CODES.has(code)) throw e
      lastErr = e
      await new Promise(r => setTimeout(r, 600 + i * 600))
    }
  }
  throw lastErr
}

// ── Org + anchor email ────────────────────────────────────────────────────────
// ExtractedOpportunity.rawEmailId is a required FK. One shared placeholder email
// per org anchors every seed opp (mirrors scripts/seed-tiered-matches.ts). Its
// receivedDateTime is deliberately old so it never becomes the sync high-water mark.
export async function getOrgAndAnchor(): Promise<{ orgId: string; rawEmailId: string }> {
  const org = await prisma.organization.findUnique({ where: { slug: ORG_SLUG }, select: { id: true } })
  if (!org) throw new Error(`Org "${ORG_SLUG}" not found — run scripts/seed-tenancy.ts first.`)
  const graphMessageId = `${TAG}-anchor-email`
  const email = await prisma.rawEmail.upsert({
    where: { graphMessageId },
    update: {},
    create: {
      graphMessageId,
      subject: `${TAG} seed anchor (Brief 10.0)`,
      receivedDateTime: new Date('2020-01-01T00:00:00Z'),
      organizationId: org.id,
      processed: true,
    },
    select: { id: true },
  })
  return { orgId: org.id, rawEmailId: email.id }
}

// ── Deterministic RNG (mulberry32) — reproducible reruns after a cleanup ───────
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
    // weighted pick: buckets = [[value, weight], ...]
    weighted: <T>(buckets: readonly [T, number][]): T => {
      const total = buckets.reduce((s, [, w]) => s + w, 0)
      let r = next() * total
      for (const [v, w] of buckets) { if ((r -= w) <= 0) return v }
      return buckets[buckets.length - 1][0]
    },
  }
}

// ── Name pools (plausible NYC broker-prospect names, no "John Buyer") ─────────
export const FIRST_NAMES = [
  'Aaron', 'Alexandra', 'Amir', 'Ava', 'Benjamin', 'Bianca', 'Carlos', 'Chloe', 'Daniel', 'Diana',
  'Elena', 'Ethan', 'Fatima', 'Gabriel', 'Grace', 'Hannah', 'Isabella', 'Jacob', 'Jasmine', 'Julian',
  'Katherine', 'Kevin', 'Laura', 'Leo', 'Maya', 'Michael', 'Nadia', 'Nathan', 'Olivia', 'Omar',
  'Priya', 'Rachel', 'Rafael', 'Samuel', 'Sofia', 'Theo', 'Valeria', 'Vincent', 'Wesley', 'Yuki',
  'Zoe', 'Aiden', 'Brianna', 'Caleb', 'Dominic', 'Emma', 'Felix', 'Gianna', 'Harper', 'Ivan',
]
export const LAST_NAMES = [
  'Abrams', 'Bernstein', 'Caldwell', 'Delgado', 'Esposito', 'Feldman', 'Goldberg', 'Harrington', 'Ibrahim', 'Jimenez',
  'Kaplan', 'Lombardi', 'Mancini', 'Nguyen', "O'Brien", 'Patel', 'Quinn', 'Rosenthal', 'Silva', 'Tanaka',
  'Underwood', 'Vasquez', 'Weiss', 'Xu', 'Yamamoto', 'Zimmerman', 'Alvarez', 'Brooks', 'Castellano', 'Donovan',
  'Ellison', 'Ferrara', 'Greenberg', 'Hoffman', 'Iverson', 'Jacobs', 'Kowalski', 'Levine', 'Moreno', 'Novak',
]
export const BROKER_FIRST = ['Ryan', 'Jessica', 'Marcus', 'Danielle', 'Anthony', 'Stephanie', 'Brian', 'Nicole', 'David', 'Christina']
export const BROKER_LAST = ['Martin', 'Serrano', 'Klein', 'Ferrari', 'Chen', 'Okafor', 'Reyes', 'Cohen', 'Walsh', 'Petrov']

// ── Neighborhood catalog (canonical spellings — resolve via fromRaw for geo) ──
// basePrice = a plausible 2BR condo SALE midpoint; rentBase = a 2BR monthly rent.
export interface Hood { name: string; borough: string; basePrice: number; rentBase: number }
export const HOODS: Hood[] = [
  // Manhattan
  { name: 'Tribeca',            borough: 'Manhattan', basePrice: 4_500_000, rentBase: 8_500 },
  { name: 'Soho',               borough: 'Manhattan', basePrice: 4_000_000, rentBase: 8_000 },
  { name: 'West Village',       borough: 'Manhattan', basePrice: 3_500_000, rentBase: 7_200 },
  { name: 'Noho',               borough: 'Manhattan', basePrice: 3_200_000, rentBase: 7_000 },
  { name: 'Flatiron',           borough: 'Manhattan', basePrice: 2_800_000, rentBase: 6_400 },
  { name: 'Nolita',             borough: 'Manhattan', basePrice: 2_800_000, rentBase: 6_200 },
  { name: 'Chelsea',            borough: 'Manhattan', basePrice: 2_600_000, rentBase: 6_000 },
  { name: 'Upper West Side',    borough: 'Manhattan', basePrice: 2_400_000, rentBase: 5_600 },
  { name: 'Upper East Side',    borough: 'Manhattan', basePrice: 2_200_000, rentBase: 5_200 },
  { name: 'Midtown East',       borough: 'Manhattan', basePrice: 2_000_000, rentBase: 5_000 },
  { name: 'Midtown West',       borough: 'Manhattan', basePrice: 2_000_000, rentBase: 5_000 },
  { name: 'East Village',       borough: 'Manhattan', basePrice: 1_900_000, rentBase: 4_800 },
  { name: 'Financial District', borough: 'Manhattan', basePrice: 1_900_000, rentBase: 4_900 },
  { name: 'Lower East Side',    borough: 'Manhattan', basePrice: 1_800_000, rentBase: 4_600 },
  { name: 'Harlem',             borough: 'Manhattan', basePrice: 1_100_000, rentBase: 3_400 },
  // Brooklyn
  { name: 'DUMBO',              borough: 'Brooklyn',  basePrice: 2_600_000, rentBase: 6_000 },
  { name: 'Brooklyn Heights',   borough: 'Brooklyn',  basePrice: 2_400_000, rentBase: 5_600 },
  { name: 'Cobble Hill',        borough: 'Brooklyn',  basePrice: 2_200_000, rentBase: 5_200 },
  { name: 'Park Slope',         borough: 'Brooklyn',  basePrice: 2_000_000, rentBase: 4_800 },
  { name: 'Williamsburg',       borough: 'Brooklyn',  basePrice: 1_900_000, rentBase: 4_900 },
  { name: 'Fort Greene',        borough: 'Brooklyn',  basePrice: 1_800_000, rentBase: 4_400 },
  { name: 'Prospect Heights',   borough: 'Brooklyn',  basePrice: 1_700_000, rentBase: 4_200 },
  { name: 'Greenpoint',         borough: 'Brooklyn',  basePrice: 1_600_000, rentBase: 4_300 },
  { name: 'Bushwick',           borough: 'Brooklyn',  basePrice: 1_200_000, rentBase: 3_600 },
  // Queens
  { name: 'Long Island City',   borough: 'Queens',    basePrice: 1_300_000, rentBase: 3_900 },
  { name: 'Astoria',            borough: 'Queens',    basePrice: 1_000_000, rentBase: 3_200 },
]
export const HOOD_BY_NAME: Record<string, Hood> = Object.fromEntries(HOODS.map(h => [h.name, h]))

// Known adjacency pairs (subset of lib/domain/Neighborhood.ts) for WARM near-misses:
// listing in an ADJACENT hood → matcher caps at Warm.
export const ADJACENT_PAIRS: [string, string][] = [
  ['Chelsea', 'Flatiron'],
  ['Williamsburg', 'Greenpoint'],
  ['Upper East Side', 'Midtown East'],
  ['Cobble Hill', 'Brooklyn Heights'],
  ['West Village', 'Soho'],
  ['Long Island City', 'Astoria'],
  ['East Village', 'Lower East Side'],
  ['Park Slope', 'Prospect Heights'],
]

// ── Brokerages (mix; ~SE variants render the ⭐ SE-priority badge) ─────────────
// resolveSourceBadge() → 'streeteasy_expert' ONLY when the string matches
// /street\s*easy/i, so "StreetEasy Experts"/"Street Easy" are the ones that flip
// the badge. Plain "SE ..." resolves to 'inbox' — kept in the mix for realism.
export const SE_BROKERAGE = 'StreetEasy Experts'
export const BROKERAGES: [string, number][] = [
  ['Douglas Elliman', 5], ['Compass', 4], ['Corcoran', 3], ['Serhant', 2],
  ['StreetEasy Experts', 2], ['SE Group NYC', 1],
]

// ── Beds / budget tiers ───────────────────────────────────────────────────────
export function budgetForTier(tier: string, rng: ReturnType<typeof makeRng>): [number, number] {
  switch (tier) {
    case 'starter': return [500_000, 1_000_000]
    case 'mid':     return [1_000_000, 3_000_000]
    case 'luxury':  return [3_000_000, 8_000_000]
    case 'ultra':   return [8_000_000, 25_000_000]
    default:        return [0, 0]
  }
  void rng
}

// Round a price to a realistic figure.
export function roundPrice(n: number): number {
  if (n >= 3_000_000) return Math.round(n / 250_000) * 250_000
  if (n >= 1_000_000) return Math.round(n / 100_000) * 100_000
  return Math.round(n / 25_000) * 25_000
}
export function roundRent(n: number): number { return Math.round(n / 100) * 100 }

// ── Category → transactionType ────────────────────────────────────────────────
const SALE_CATS = new Set<Category>([
  Category.COMING_SOON_SALE, Category.OFF_MARKET_SALE, Category.ACTIVE_SALE_LISTING,
  Category.PRICE_DROP, Category.BACK_ON_MARKET, Category.DEVELOPMENT_INVENTORY,
  Category.SPONSOR_UNIT, Category.COMING_SOON_DEVELOPMENT,
])
const RENTAL_CATS = new Set<Category>([Category.RENTAL_LISTING, Category.COMING_SOON_RENTAL])
export function txForCategory(c: Category): TransactionType {
  if (SALE_CATS.has(c)) return TransactionType.SALE
  if (RENTAL_CATS.has(c)) return TransactionType.RENTAL
  if (c === Category.BUYER_ISO) return TransactionType.BUYER_NEED
  if (c === Category.RENTER_INQUIRY) return TransactionType.RENTER_NEED
  if (c === Category.SELLER_LEAD) return TransactionType.SELLER_LEAD
  if (c === Category.LANDLORD_LEAD) return TransactionType.LANDLORD_LEAD
  return TransactionType.UNKNOWN
}

// ── Embeddings ────────────────────────────────────────────────────────────────
// Opp: reuse the production text builder + upsert helper.
export async function embedOpp(oppId: string, o: Parameters<typeof buildOpportunityText>[0]): Promise<void> {
  await upsertOpportunityEmbedding(oppId, buildOpportunityText(o))
}

// Mojo: replicate the webhook's embedContact text shape, then raw-UPDATE the
// Unsupported("vector") column (Prisma create can't set it directly).
export async function embedMojo(mojoContactId: string, c: {
  fullName: string; address?: string | null; city?: string | null
  neighborhood?: string | null; notes?: string | null; tags?: string[]
}): Promise<void> {
  const text = [c.fullName, c.address, c.city, c.neighborhood, c.notes, ...(c.tags ?? [])].filter(Boolean).join(' ')
  const vector = await embedText(text)
  const pgVector = `[${vector.join(',')}]`
  await prisma.$executeRaw`UPDATE "MojoContact" SET embedding = ${pgVector}::vector WHERE id = ${mojoContactId}`
}

// ── Small utilities ───────────────────────────────────────────────────────────
export function fullName(rng: ReturnType<typeof makeRng>): string {
  return `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`
}
export function brokerName(rng: ReturnType<typeof makeRng>): string {
  return `${rng.pick(BROKER_FIRST)} ${rng.pick(BROKER_LAST)}`
}
export function emailFrom(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${SEED_DOMAIN}`
}
export function nycPhone(rng: ReturnType<typeof makeRng>): string {
  const area = rng.pick(['212', '646', '917', '718', '347', '929'])
  return `(${area}) ${rng.int(200, 999)}-${String(rng.int(0, 9999)).padStart(4, '0')}`
}
// A plausible NYC street address.
export function streetAddress(rng: ReturnType<typeof makeRng>): string {
  const streets = ['Broadway', 'Bleecker St', 'Hudson St', '5th Ave', 'Madison Ave', 'Bedford Ave',
    'Court St', 'Smith St', 'Metropolitan Ave', 'W 23rd St', 'E 72nd St', 'Vernon Blvd', 'DeKalb Ave',
    'Grand St', 'Lexington Ave', 'Columbus Ave', 'Atlantic Ave', 'Franklin St']
  const unit = rng.chance(0.6) ? `, Apt ${rng.int(2, 40)}${rng.pick(['A', 'B', 'C', 'D', 'E', 'F'])}` : ''
  return `${rng.int(10, 899)} ${rng.pick(streets)}${unit}`
}

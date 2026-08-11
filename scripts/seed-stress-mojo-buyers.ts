// Brief 10.0 — Part A: ~200 SE Buyer Mojo contacts (stress-test variety).
//
// Direct Prisma inserts into the app org (dealflow-ryan). All rows: intent=BUYER,
// isTestData=true, fullName prefixed [TEST_10], metadata.seedBrief='10.0'.
// Embeddings generated for every row. No webhook, no geocoder, no Sonnet.
//
// Run:   npx tsx scripts/seed-stress-mojo-buyers.ts
// Wipe:  npx tsx scripts/seed-stress-cleanup.ts
import {
  TAG, getOrgAndAnchor, ensureConnected, makeRng, HOODS, budgetForTier, embedMojo,
  fullName, nycPhone, emailFrom,
} from './seed-stress-common'
import { prisma } from '../lib/prisma'

const TARGET = 200

// Exact-count partitions for the two primary axes (shuffled, then zipped).
function partition<T>(spec: [T, number][]): T[] {
  const out: T[] = []
  for (const [v, n] of spec) for (let i = 0; i < n; i++) out.push(v)
  return out
}
function shuffle<T>(arr: T[], rng: ReturnType<typeof makeRng>): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) { const j = rng.int(0, i); [a[i], a[j]] = [a[j], a[i]] }
  return a
}

async function pooled<T>(items: T[], size: number, fn: (t: T, i: number) => Promise<void>): Promise<void> {
  let idx = 0
  async function worker() { while (idx < items.length) { const i = idx++; await fn(items[i], i) } }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
}

async function main() {
  await ensureConnected()
  const existing = await prisma.mojoContact.count({ where: { fullName: { startsWith: `${TAG} ` } } })
  if (existing > 0) {
    console.log(`${existing} ${TAG} Mojo contacts already exist — skipping insert. Run cleanup for a fresh seed.`)
    await prisma.$disconnect(); return
  }

  const { orgId } = await getOrgAndAnchor()
  const rng = makeRng(0xA10A) // "A10" seed → reproducible

  const budgetTiers = shuffle(partition<string>([
    ['starter', 30], ['mid', 60], ['luxury', 60], ['ultra', 30], ['none', 20],
  ]), rng)
  const bedBuckets = shuffle(partition<number>([
    [0, 15], [1, 40], [2, 60], [3, 50], [4, 25], [-1, 10], // 0=studio, -1=unspecified
  ]), rng)

  const embedJobs: { id: string; fullName: string; address: string | null; city: string; neighborhood: string | null; notes: string | null; tags: string[] }[] = []

  for (let i = 0; i < TARGET; i++) {
    const name = `${TAG} ${fullName(rng)}`
    const mojoId = `TEST10-M-${String(i + 1).padStart(4, '0')}`

    // Budget
    const tier = budgetTiers[i]
    const [budgetMin, budgetMax] = tier === 'none' ? [null, null] : budgetForTier(tier, rng)

    // Beds
    const bb = bedBuckets[i]
    const bedsMin = bb === -1 ? null : bb
    const bedsMax = bb === -1 ? null : bb === 4 ? (rng.chance(0.4) ? 5 : 4) : bb

    // Neighborhood: ~65% specific, else broad (null)
    const hood = rng.chance(0.65) ? rng.pick(HOODS) : null
    const neighborhood = hood?.name ?? null

    // cashOnly: true 30 / false 140 / null 30 (weighted ≈ target proportions)
    const cashOnly = rng.weighted<boolean | null>([[true, 30], [false, 140], [null, 30]])

    // timing
    const timing = rng.weighted<string | null>([['now', 40], ['3 months', 60], ['6 months', 40], ['flexible', 40], [null, 20]])

    // Notes quality: 60% rich / 30% sparse / 10% empty
    const bedLabel = bb === 0 ? 'studio' : bb === -1 ? 'flexible layout' : bb >= 4 ? `${bb}BR+` : `${bb}BR`
    const hoodLabel = neighborhood ?? 'open on location'
    const budgetLabel = budgetMax ? `up to $${(budgetMax / 1_000_000).toFixed(1)}M` : 'budget flexible'
    const cashLabel = cashOnly === true ? 'all cash' : cashOnly === false ? 'financing, pre-approved' : ''
    const timingLabel = timing && timing !== 'flexible' ? `wants to close ${timing === 'now' ? 'ASAP' : `in ${timing}`}` : 'timing flexible'
    const notes = rng.weighted<'rich' | 'sparse' | 'empty'>([['rich', 60], ['sparse', 30], ['empty', 10]]) === 'rich'
      ? `Buyer seeking ${bedLabel} in ${hoodLabel}, ${budgetLabel}. ${[cashLabel, timingLabel].filter(Boolean).join('; ')}.`
      : rng.weighted<'rich' | 'sparse' | 'empty'>([['rich', 0], ['sparse', 75], ['empty', 25]]) === 'sparse'
        ? `${bedLabel} ${hoodLabel} buyer`
        : null

    // Contact completeness: 95% both / 3% phone-only / 2% email-only
    const completeness = rng.weighted<'both' | 'phone' | 'email'>([['both', 95], ['phone', 3], ['email', 2]])
    const email = completeness === 'phone' ? null : emailFrom(name.replace(TAG, '').trim())
    const phone = completeness === 'email' ? null : nycPhone(rng)

    const tags = ['buyer'] // deferred loadMojoDemandParties keys on this; harmless for test rows

    const row = await prisma.mojoContact.create({
      data: {
        organizationId: orgId, mojoId, fullName: name,
        email, phone, city: 'New York',
        mojoList: 'SE Buyers', intent: 'BUYER', isTestData: true,
        bedsMin, bedsMax, budgetMin, budgetMax, cashOnly, timing,
        initialNeighborhood: neighborhood, neighborhood,
        notes, tags, groups: [],
        metadata: { seedBrief: '10.0' },
      },
      select: { id: true },
    })
    embedJobs.push({ id: row.id, fullName: name, address: null, city: 'New York', neighborhood, notes, tags })
    if ((i + 1) % 50 === 0) console.log(`  inserted ${i + 1}/${TARGET} contacts`)
  }

  console.log('Generating embeddings…')
  let done = 0
  await pooled(embedJobs, 8, async (j) => {
    await embedMojo(j.id, j)
    if (++done % 50 === 0) console.log(`  embedded ${done}/${embedJobs.length}`)
  })

  const total = await prisma.mojoContact.count({ where: { fullName: { startsWith: `${TAG} ` } } })
  console.log(`\n✅ Seeded ${total} ${TAG} Mojo BUYER contacts (intent=BUYER, isTestData=true), all embedded.`)
  await prisma.$disconnect()
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })

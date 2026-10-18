import 'dotenv/config'
// Direct spot-check #8 — Buyer Match generator (Brief 27.0).
// Runs generateBuyerMatchReport against a seed [TEST_10] buyer, logs the section
// shape + markdown length + sources. Saves NOTHING. For debugging the generator
// in isolation from the chat route.
// Run: npx tsx scripts/tests/08-report-generator.ts [buyerId]
import { prisma } from '@/lib/prisma'
import Anthropic from '@anthropic-ai/sdk'
import { generateBuyerMatchReport, generateBuyerMatchSection } from '@/lib/reports/generators/buyer-match'
import { refuseLiveDatabase } from '@/lib/dbGuard'

// Brief 41.2 (engineering precaution): a spot check against seed data that
// spends Anthropic money, so it refuses any database but a *_perf or *_test
// one, with no override.
refuseLiveDatabase(process.env.DATABASE_URL, 'scripts/tests/08-report-generator.ts (DATABASE_URL)')

// Default: [TEST_10] SE Buyer ISO — 2BR Soho (1 HOT, 3 WARM, 1 POSSIBLE).
const BUYER_ID = process.argv[2] ?? 'cmsp7l5he001qloo89haui4u2'

async function main() {
  console.log('=== Buyer Match generator spot-check ===')
  console.log('buyerId:', BUYER_ID)
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const t0 = Date.now()
  const report = await generateBuyerMatchReport({ buyerId: BUYER_ID, prisma, anthropic })
  const ms = Date.now() - t0

  console.log(`\n✓ generated in ${ms}ms`)
  console.log('subject:', report.subject)
  console.log('matchCount (HOT):', report.matchCount)
  console.log('sections:', report.sections.length)
  for (const s of report.sections) {
    const items = s.content.items?.length ?? 0
    const metrics = s.content.metrics?.length ?? 0
    const prose = s.content.prose ? s.content.prose.length : 0
    console.log(`  - ${s.key.padEnd(24)} prose=${prose}c items=${items} metrics=${metrics} sources=${s.sources.length}`)
  }
  console.log('markdown length:', report.markdown.length)
  console.log('total sources:', report.sources.length, JSON.stringify(report.sources.map(s => s.type)))

  console.log('\n--- markdown preview (first 1200 chars) ---')
  console.log(report.markdown.slice(0, 1200))

  console.log('\n--- fragment: near-misses ---')
  const frag = await generateBuyerMatchSection({ sectionKey: 'near-misses', buyerId: BUYER_ID, prisma, anthropic })
  console.log('title:', frag.title, '| items:', frag.content.items?.length, '| prose:', frag.content.prose?.slice(0, 200))

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })

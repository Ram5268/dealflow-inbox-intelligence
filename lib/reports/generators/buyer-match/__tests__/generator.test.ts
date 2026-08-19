import 'dotenv/config'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { prisma } from '../../../../prisma'
import { generateBuyerMatchReport, generateBuyerMatchSection } from '../index'

// Run via `npm test`. End-to-end against the real DB, but Sonnet is OMITTED
// (anthropic undefined) so the one LLM section falls back deterministically — no
// API key, no cost, no flake. Picks a seed [TEST_10] BUYER_ISO with matches
// dynamically so it survives seed-id churn; skips cleanly if the seed is absent.

async function findSeedBuyerWithMatches(): Promise<string | null> {
  const grouped = await prisma.match.groupBy({
    by: ['counterpartId'],
    where: { counterpartType: 'opportunity' },
    _count: true,
    orderBy: { _count: { counterpartId: 'desc' } },
    take: 20,
  })
  for (const g of grouped) {
    const opp = await prisma.extractedOpportunity.findUnique({
      where: { id: g.counterpartId },
      select: { id: true, category: true, isTestData: true },
    })
    if (opp && opp.isTestData && opp.category === 'BUYER_ISO') return opp.id
  }
  return null
}

after(async () => { await prisma.$disconnect() })

test('generateBuyerMatchReport returns 8 sections, sources, and non-trivial markdown', async () => {
  const buyerId = await findSeedBuyerWithMatches()
  if (!buyerId) {
    console.log('  (skip) no seed BUYER_ISO with matches in this DB')
    return
  }
  // anthropic omitted → recommended-adjustment uses its deterministic fallback.
  const report = await generateBuyerMatchReport({ buyerId, prisma })

  assert.equal(report.sections.length, 8, 'exactly 8 sections')
  const keys = report.sections.map(s => s.key)
  assert.deepEqual(keys, [
    'criteria', 'matching-inventory', 'curated-matches', 'near-misses',
    'off-market', 'budget-reality', 'showing-schedule', 'recommended-adjustment',
  ], 'section keys in template order')

  assert.ok(report.sources.length > 0, 'sources array is non-empty')
  assert.ok(typeof report.markdown === 'string' && report.markdown.length > 500, 'markdown is a non-trivial string')
  assert.ok(report.markdown.includes('Buyer Match'), 'markdown carries the report title')
  assert.ok(report.subject.length > 0, 'subject is set')
  assert.ok(report.matchCount >= 0, 'matchCount is a number')

  // Every section carries at least one source (provenance is never empty).
  for (const s of report.sections) {
    assert.ok(s.sources.length > 0, `section ${s.key} has sources`)
  }
})

test('generateBuyerMatchSection returns a single named section (fragment path)', async () => {
  const buyerId = await findSeedBuyerWithMatches()
  if (!buyerId) { console.log('  (skip) no seed buyer'); return }
  const frag = await generateBuyerMatchSection({ sectionKey: 'near-misses', buyerId, prisma })
  assert.equal(frag.key, 'near-misses')
  assert.equal(frag.title, 'Near misses')
  assert.ok(frag.sources.length > 0)
})

test('generateBuyerMatchSection rejects an unknown section key', async () => {
  const buyerId = await findSeedBuyerWithMatches()
  if (!buyerId) { console.log('  (skip) no seed buyer'); return }
  await assert.rejects(
    () => generateBuyerMatchSection({ sectionKey: 'not-a-section', buyerId, prisma }),
    /unknown section/i,
  )
})

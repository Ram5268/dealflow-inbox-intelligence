// Brief 41.1 (PR H, review F12) — re-extract never wipes an email's saved
// listings with an AI answer that has none (empty of listings, noise only,
// irrelevant or malformed entries), unless the request sends "force": true.
// Pure: no DB, no network; the route is checked by reading its source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { forceRequested, listingEntries, reextractSwapDecision } from '../reextractGuard'

const ROOT = join(__dirname, '..', '..')
const listing = (over: Record<string, unknown> = {}) => ({ isRelevant: true, category: 'ACTIVE_SALE_LISTING', extractedTitle: '12 Main St', ...over })

test('noise, irrelevant and malformed entries are not listings', () => {
  const noiseOnly = [listing({ isRelevant: false, category: 'NOISE' }), listing({ category: 'NOISE' })]
  const irrelevant = [listing({ isRelevant: false }), listing({ isRelevant: undefined })]
  const malformed: unknown[] = [null, undefined, 'ACTIVE_SALE_LISTING', 42, [], {}, { isRelevant: true }, listing({ category: 'FOO' }), listing({ category: 7 })]
  for (const answer of [noiseOnly, irrelevant, malformed, [...noiseOnly, ...irrelevant, ...malformed]]) {
    assert.deepEqual(listingEntries(answer), [])
  }
  const good = listing({ category: 'OFF_MARKET_SALE' })
  assert.deepEqual(listingEntries([...noiseOnly, good, ...malformed]), [good])
})

test('no swap when the new answer has no listings and the email has some; force swaps', () => {
  for (const answer of [
    [listing({ isRelevant: false, category: 'NOISE' })], // noise only
    [listing({ isRelevant: false })],                    // irrelevant only
    [null, 'oops', { isRelevant: true }],                // malformed only
  ]) {
    const fresh = listingEntries(answer as unknown[]).length
    const kept = reextractSwapDecision({ saved: 3, fresh, force: false })
    assert.equal(kept.swap, false)
    assert.equal(kept.kept, 3)
    assert.match(kept.reason ?? '', /kept the 3 saved listing\(s\).*"force": true/)
    assert.deepEqual(reextractSwapDecision({ saved: 3, fresh, force: true }), { swap: true })
  }
  // A real answer still replaces the old listings (the point of re-extract).
  assert.deepEqual(reextractSwapDecision({ saved: 3, fresh: 1, force: false }), { swap: true })
  assert.deepEqual(reextractSwapDecision({ saved: 0, fresh: 2, force: false }), { swap: true })
  // Nothing saved and nothing new: nothing to do, and nothing to report as kept.
  const none = reextractSwapDecision({ saved: 0, fresh: 0, force: false })
  assert.equal(none.swap, false)
  assert.equal(none.kept, undefined)
})

test('only "force": true forces the swap', () => {
  assert.equal(forceRequested({ force: true }), true)
  for (const body of [{}, { force: 'true' }, { force: 1 }, { force: 'yes' }, { force: false }, null, undefined, 'force', [true]]) {
    assert.equal(forceRequested(body), false, JSON.stringify(body))
  }
})

test('the route decides before it swaps, swaps only when allowed, and reports what it kept', () => {
  const s = readFileSync(join(ROOT, 'app/api/sync/reextract/route.ts'), 'utf8')
  const fresh = s.indexOf('for (const ext of listingEntries(results))')
  const count = s.indexOf('const saved = await prisma.extractedOpportunity.count({ where: { rawEmailId: email.id } })')
  const decide = s.indexOf('const decision = reextractSwapDecision({ saved, fresh: fresh.length, force })')
  const gate = s.indexOf('if (decision.swap) {')
  const tx = s.indexOf('await prisma.$transaction([')
  assert.ok(fresh > 0 && count > fresh && decide > count && gate > decide && tx > gate, 'listings, count, decision, then the swap')
  assert.equal(s.split('await prisma.$transaction([').length - 1, 1, 'one swap')
  assert.match(s, /const force = forceRequested\(body\)/)
  assert.match(s, /\} else \{\s*\n\s*if \(decision\.kept\) skipped\+\+/)
  assert.match(s, /return NextResponse\.json\(\{ totalDeleted, totalCreated, failed, skipped, summary \}\)/)
})

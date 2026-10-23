import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RYAN_MD, buildSystemBlocks } from '../systemBlocks'
import { buildGroundingCorpus } from '../guards/toolBinding'

// Brief 29.0 — RYAN.md always-on side-channel glossary.
// Run via `npm test` (ts-node). Relative imports only — ts-node does not resolve
// the @/ alias. No network / Prisma / Anthropic calls: pure string + assembly.
//
// Coverage:
//  1. RYAN_MD is a non-empty string carrying the expected vocabulary sections.
//  2. buildSystemBlocks places RYAN_MD as the 2nd block, both static blocks
//     cached (ephemeral), dynamic block appended uncached.
//  3. The guard grounding corpus, fed RYAN_MD as side-channel text, contains the
//     glossary vocabulary (so Sonnet quoting it isn't flagged as hallucinated).

test('RYAN_MD is a non-empty string with the expected section headers', () => {
  assert.equal(typeof RYAN_MD, 'string')
  assert.ok(RYAN_MD.length > 0, 'RYAN_MD should not be empty')
  // Brief 30.0 — v2 restructure: title + 10 numbered sections.
  // Brief 43 PR 1: Drift, never "Jarvis" (D3, Brief 42 default).
  assert.match(RYAN_MD, /# RYAN\.md — Ryan's playbook for Drift/)
  assert.match(RYAN_MD, /HARD RULES/)
  assert.match(RYAN_MD, /ROUTING META-RULES/)
  assert.match(RYAN_MD, /CONTEXT-RESOLUTION PROCEDURE/)
  assert.match(RYAN_MD, /NEIGHBORHOOD & GEOGRAPHY VOCAB/)
  assert.match(RYAN_MD, /REPORT-INTENT ROUTING/)
  assert.match(RYAN_MD, /NON-REPORT WORKFLOW PATTERNS/)
  assert.match(RYAN_MD, /AMBIGUITY & CORRECTION HANDLING/)
  assert.match(RYAN_MD, /my \[X\] inventory/i)
  assert.match(RYAN_MD, /SHORT CONTINUATIONS/)
})

// Brief 48 PR 19 [Ryan 1.11]: the Buyer Match report is the only one; the 20
// locked templates' routing (the old Section 6b list) is gone, and another
// report request gets one line saying so (lib/reports/__tests__/oneTemplate.unit.test.ts
// checks every place that names a template).
test('RYAN_MD routes reports to the Buyer Match report only', () => {
  assert.match(RYAN_MD, /templateId: buyer-match\. The only report DealFlow makes\./)
  assert.match(RYAN_MD, /"DealFlow makes one report, the Buyer Match report\./)
  for (const gone of ['P-01', 'M-01', 'O-02', 'Seller Activity', 'Market Snapshot', 'LP Update', 'unlocked', 'roadmap']) {
    assert.ok(!RYAN_MD.slice(0, RYAN_MD.indexOf('## GROWTH LOG')).includes(gone), gone)
  }
})

test('buildSystemBlocks: RYAN_MD is block[1], both static blocks cached, dynamic appended uncached', () => {
  const SYSTEM = 'SYSTEM_PROMPT_STUB'
  const dynamic = 'live ACRIS side-channel text'
  const blocks = buildSystemBlocks(SYSTEM, dynamic)

  assert.equal(blocks.length, 3)
  // [0] SYSTEM_PROMPT, cached
  assert.equal(blocks[0].text, SYSTEM)
  assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' })
  // [1] RYAN_MD, cached
  assert.equal(blocks[1].text, RYAN_MD)
  assert.deepEqual(blocks[1].cache_control, { type: 'ephemeral' })
  // [2] dynamic side-channel, NOT cached
  assert.equal(blocks[2].text, dynamic)
  assert.equal(blocks[2].cache_control, undefined)
})

test('buildSystemBlocks: dynamic block omitted when empty', () => {
  const blocks = buildSystemBlocks('SYSTEM_PROMPT_STUB', '')
  assert.equal(blocks.length, 2)
  assert.equal(blocks[1].text, RYAN_MD)
  assert.deepEqual(blocks[1].cache_control, { type: 'ephemeral' })
})

test('grounding corpus fed RYAN_MD contains glossary vocabulary', () => {
  const sideChannelText = [RYAN_MD, ''].filter(Boolean).join('\n\n') || null
  const corpus = buildGroundingCorpus([], null, sideChannelText)
  // normalizeForTrace lowercases + collapses non-alphanumerics to spaces, so the
  // "WV = West Village" line surfaces as "west village" in the corpus.
  assert.ok(corpus.includes('west village'), 'corpus should contain "west village"')
  assert.ok(corpus.includes('off market'), 'corpus should contain "off market" (off-market vocabulary)')
  // Brief 30.0 — v2 vocabulary must also be grounded so Sonnet quoting it isn't flagged.
  assert.ok(corpus.includes('curated matches'), 'corpus should contain "curated matches" (Section 6a)')
  // Brief 48 PR 19: Section 6b names the one report there is.
  assert.ok(corpus.includes('buyer match report'), 'corpus should contain "buyer match report" (Section 6b)')
})

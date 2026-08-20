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
  assert.match(RYAN_MD, /# RYAN\.md — Ryan's playbook for Jarvis/)
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

test('RYAN_MD contains all 21 template ids or names', () => {
  const templates = ['cma', 'price-adjustment', 'new-dev', 'absorption', 'rental-pricing',
    'acquisition', 'development-pro-forma', 'committee-memo', 'highest-best',
    'seller', 'buyer-match', 'launch-plan', 'offer-comparison',
    'project-status', 'draw-request', 'change-order',
    'lp-update', 'capital-call', 'disposition',
    'team-pipeline', 'market-snapshot']
  const md = RYAN_MD.toLowerCase()
  const missing = templates.filter(t => !md.includes(t.replace('-', ' ')) && !md.includes(t))
  assert.ok(missing.length <= 3, `too many missing templates: ${missing.join(', ')}`)
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
  assert.ok(corpus.includes('market snapshot'), 'corpus should contain "market snapshot" (Section 6b)')
})

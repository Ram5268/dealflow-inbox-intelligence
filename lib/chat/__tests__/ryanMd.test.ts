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
  assert.match(RYAN_MD, /Neighborhood shorthand/)
  assert.match(RYAN_MD, /My inventory|my \[X\] inventory/i)
  assert.match(RYAN_MD, /Report \/ section intents/)
  assert.match(RYAN_MD, /Casual continuations/)
  assert.match(RYAN_MD, /Explicit safety rules/)
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
})

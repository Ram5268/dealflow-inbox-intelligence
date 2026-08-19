import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildGroundingCorpus,
  filterToolBoundFlags,
  isTraceableToTools,
  normalizeForTrace,
} from '../toolBinding'
import { scanForStructuralHallucinations } from '../regexGuard'
import type { RegexFlag } from '../regexGuard'
import type { ToolResultForVerify } from '../llmVerifier'
import { verifyResponse, type VerifierClient } from '../llmVerifier'

// Run: `npm test` (ts-node via node:test). Pure + injected-client — no real API.
//
// Brief 11.0, Fix #1 — tool-output binding. The guard must scope to specific
// entity claims that AREN'T backed by tool output. A tool-backed LLC/owner name
// (Ryan's Mojo seller leads are routinely LLCs) must pass; a fabricated one must
// still fire. These pin both directions of the safety property.

const rx = (pattern: string, match: string): RegexFlag => ({ pattern, match })

// The exact tool output shape the guard sees this turn: search_parties returning
// the Mojo seller lead that broke dogfooding ("Tompkins Mazal Bh 101 LLC").
const MOJO_TOOL_RESULTS: ToolResultForVerify[] = [
  {
    name: 'search_parties',
    input: { role: 'seller', borough: 'Brooklyn', neighborhoods: ['Bedford-Stuyvesant', 'Clinton Hill', 'Fort Greene'] },
    output: {
      cards: [
        { id: 'cmsp7jgww0040', category: 'MOJO_LEAD', name: 'Tompkins Mazal Bh 101 LLC', phone: '917-555-0188', neighborhood: 'Bedford-Stuyvesant', role: 'seller' },
        { id: 'cmsp7j9z90022', category: 'MOJO_LEAD', name: 'Clinton Hill Estates LLC', phone: '917-555-0142', neighborhood: 'Clinton Hill', role: 'seller' },
      ],
      totalMatched: 2,
    },
  },
]

// ── normalize / trace primitives ─────────────────────────────────────────────
test('normalizeForTrace lowercases and collapses punctuation', () => {
  assert.equal(normalizeForTrace('Tompkins Mazal Bh 101 LLC'), 'tompkins mazal bh 101 llc')
  assert.equal(normalizeForTrace('  461 SIXTH  STREET   HOLDINGS,  LLC. '), '461 sixth street holdings llc')
})

test('isTraceableToTools finds an entity present in the corpus', () => {
  const corpus = buildGroundingCorpus(MOJO_TOOL_RESULTS)
  assert.equal(isTraceableToTools('Tompkins Mazal Bh 101 LLC', corpus), true)
  assert.equal(isTraceableToTools('Fabricated Holdings LLC', corpus), false)
})

// ── Turn 4 of the Bedstuy transcript — SHOULD NOW PASS (was failing pre-fix) ──
// Simulate: prior turn offered "want me to pull Mojo sellers?"; current turn the
// user said "yes let's pull those"; the assistant response names a Mojo contact
// returned from search_parties. The structural guard fired corporate_entity on
// the LLC name — but it's tool-backed, so tool-binding drops the flag → pass.
test('affirmative continuation with tool call passes guard', () => {
  const response =
    'Here are the Mojo cold leads in those neighborhoods: Tompkins Mazal Bh 101 LLC in Bedford-Stuyvesant, ph 917-555-0188, and Clinton Hill Estates LLC in Clinton Hill. Both are expired-listing owners worth an off-market approach.'

  const rawFlags = scanForStructuralHallucinations(response)
  // The raw regex DOES flag the LLC names structurally...
  assert.ok(rawFlags.some(f => f.pattern === 'corporate_entity'), 'raw regex should flag the LLC names')

  const corpus = buildGroundingCorpus(MOJO_TOOL_RESULTS)
  const scoped = filterToolBoundFlags(rawFlags, corpus)
  // ...but tool-binding clears them because they trace to search_parties output.
  assert.deepEqual(scoped, [], 'tool-backed entity names must not survive as flags')
})

// ── Preserve existing safety: fabricated claims still blocked ─────────────────
// Response mentions an entity with NO tool backing this turn and none in the
// prior turn's deal cards → the structural flag survives → guard still fires.
test('fabricated entity claim without tool backing still blocks', () => {
  const response =
    'You could also reach out to Sarah Chen Holdings LLC, a great off-market prospect in Fort Greene.'

  const rawFlags = scanForStructuralHallucinations(response)
  assert.ok(rawFlags.some(f => f.pattern === 'corporate_entity'), 'regex flags the fabricated LLC')

  const corpus = buildGroundingCorpus(MOJO_TOOL_RESULTS)
  const scoped = filterToolBoundFlags(rawFlags, corpus)
  assert.ok(
    scoped.some(f => f.pattern === 'corporate_entity' && /Sarah Chen/.test(f.match)),
    'a fabricated entity not in tool output must still fire the guard',
  )
})

// ── Non-bindable structural patterns are never exempted, even if a fragment ───
// happens to appear in tool output. A URL / external-source citation is
// un-sourceable by construction; tool-binding must not clear it.
test('non-bindable patterns (URL, source citation) are never tool-exempted', () => {
  const flags: RegexFlag[] = [
    rx('external_url', 'https://streeteasy.com/building/x'),
    rx('real_estate_source_citation', 'ACRIS'),
    rx('corporate_entity', 'Tompkins Mazal Bh 101 LLC'),
  ]
  // Corpus that (perversely) contains all three strings — only the entity clears.
  const corpus = normalizeForTrace('https://streeteasy.com/building/x ACRIS Tompkins Mazal Bh 101 LLC')
  const scoped = filterToolBoundFlags(flags, corpus)
  const patterns = scoped.map(f => f.pattern).sort()
  assert.deepEqual(patterns, ['external_url', 'real_estate_source_citation'], 'URL + source citation survive; entity is dropped')
})

// ── Prior-turn DEAL CARDS also ground an entity claim ─────────────────────────
// The safety property allows tracing to the prior turn's cards, not just this
// turn's tool call (Fix #3's prompt reduces reliance on this, but it must hold).
test('entity present only in prior-turn deal cards is grounded', () => {
  const priorDealCards = [{ id: 'SEED_SALE_09', extractedTitle: 'Prospect Heights Townhouse', address: '461 6th St' }]
  const corpus = buildGroundingCorpus([], priorDealCards)
  const flags = [rx('corporate_entity', 'Prospect Heights Townhouse')]
  assert.deepEqual(filterToolBoundFlags(flags, corpus), [], 'prior-turn card entity must be treated as grounded')
})

// ── Semantic layer still blocks a fabricated party the regex can't catch ──────
// A plain person-name + phone isn't a structural pattern; the Sonnet verifier is
// the backstop. This confirms the verifier path still fails a fabricated party.
test('semantic verifier still blocks a fabricated party not in tool output', async () => {
  const ungroundedJson = JSON.stringify({
    isGrounded: false,
    flags: [{ claim: 'Sarah Chen at 917-555-0142', reason: 'Party not present in any tool result this turn.' }],
  })
  const client = {
    messages: { create: async () => ({ content: [{ type: 'text', text: ungroundedJson }], usage: { input_tokens: 400, output_tokens: 30 } }) },
  } as unknown as VerifierClient
  const r = await verifyResponse(
    'yes pull those',
    MOJO_TOOL_RESULTS,
    null,
    'Reach out to Sarah Chen at 917-555-0142 — she is looking in Fort Greene.',
    { client },
  )
  assert.equal(r.isGrounded, false)
  assert.equal(r.flags[0].claim, 'Sarah Chen at 917-555-0142')
})

// ── Brief 26.0 — side-channel context grounds a claim (was force-fallback) ────
// The dynamic system block (ACRIS/DOB/FRED) is real evidence Sonnet was given,
// it just lives in the system prompt, not a tool result. A response quoting it
// must NOT be flagged as a hallucination. This pins BOTH guard paths: the regex
// tool-binding corpus now includes side-channel text, and the semantic verifier
// is handed that text as a second grounded-evidence section.
const CPS_SIDE_CHANNEL =
  'ACRIS PROPERTY RECORDS — 220 Central Park South\n' +
  'Current owner: 220 CENTRAL PS, LLC\n' +
  'Last sale: 2026-02-10 for $37,250,000\n' +
  'BBL: Manhattan Block 1030 Lot 1038'

test('side-channel entity is grounded by the regex tool-binding corpus', () => {
  // A corporate_entity flag for the owner named in the ACRIS side-channel block.
  const flag = rx('corporate_entity', '220 CENTRAL PS, LLC')

  // With the side-channel folded into the corpus, the flag traces → dropped.
  const withSide = buildGroundingCorpus([], null, CPS_SIDE_CHANNEL)
  assert.deepEqual(
    filterToolBoundFlags([flag], withSide),
    [],
    'owner entity present in side-channel context must be treated as grounded',
  )

  // Without the side-channel, the SAME entity has no backing → still fires.
  // This proves the corpus extension is precisely what grounds it.
  const noSide = buildGroundingCorpus([], null, null)
  assert.equal(
    filterToolBoundFlags([flag], noSide).length,
    1,
    'sanity: absent side-channel, the entity is not grounded',
  )
})

test('side-channel-grounded response is not forced to fallback by the verifier', async () => {
  // Capture what the verifier is actually handed as evidence.
  let sentToVerifier = ''
  const client = {
    messages: {
      create: async (args: { messages: Array<{ content: string }> }) => {
        sentToVerifier = JSON.stringify(args.messages)
        return {
          content: [{ type: 'text', text: '{"isGrounded": true, "flags": []}' }],
          usage: { input_tokens: 420, output_tokens: 12 },
        }
      },
    },
  } as unknown as VerifierClient

  const response = 'The owner is 220 CENTRAL PS, LLC, purchased 2026-02-10 for $37.25M.'
  const r = await verifyResponse('who owns 220 Central Park South?', [], CPS_SIDE_CHANNEL, response, { client })

  // The side-channel text reaches the verifier as grounding evidence...
  assert.ok(/220 CENTRAL PS/.test(sentToVerifier), 'side-channel context must be sent to the verifier')
  // ...and the verifier passes the response — no fallback is forced.
  assert.equal(r.isGrounded, true)
  assert.deepEqual(r.flags, [])
})

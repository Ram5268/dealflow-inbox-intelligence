// Brief 43 PR 10 (Q18, Q32; N11): Drift's stock replies and the guard's own
// instructions say what Drift really can do, and a fact-check that fails is
// logged, not turned into a stock reply.
//
// - The four stock replies and the rewrite instruction name no tools and never
//   deny the deed and permit lookups Drift has (deed owners may be named: D1
//   [Ryan, 2026-10-17]); they follow the feel standard (Brief 42 TEST_PLAN §3:
//   calm, short, no em-dashes, no "I'm afraid", Drift is "Drift").
// - A fact-check API error or an unreadable answer accepts the reply (the
//   regex check has already run) and records `verifier_api_error` /
//   `verifier_parse_error` on the attempt (Q32) [engineering precaution].
// - Drift never writes a URL: links reach Ryan as buttons (T-11).
// Pure tests: fake clients, a stand-in Prisma, no API, no database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CANNED_PUBLIC_RECORDS,
  CANNED_FINANCE,
  CANNED_SELF_DESCRIPTION,
  CANNED_GENERIC,
  NEVER_SENT_REPLY,
  buildFeedbackPrompt,
  formatFlagLines,
  type GuardTelemetry,
} from '../retry'
import { verifyResponse, VERIFIER_SYSTEM_PROMPT, type VerifierClient } from '../llmVerifier'
import { SYSTEM_PROMPT } from '../../systemPrompt'

// instrumentation.ts loads lib/prisma: give it a stand-in first (no pg Pool).
;(globalThis as unknown as { prisma: unknown }).prisma = { guardFireEvent: { create: async () => ({}) } }

const STOCK = { CANNED_PUBLIC_RECORDS, CANNED_FINANCE, CANNED_SELF_DESCRIPTION, CANNED_GENERIC }

// ── The stock replies (Q18, N11) ─────────────────────────────────────────────
for (const [name, text] of Object.entries(STOCK)) {
  test(`${name}: no tool names and no system words`, () => {
    assert.doesNotMatch(text, /search_listings|search_parties|find_seller|generate_report|\btools?\b|database|\bsystem\b|Mojo|isTestData|Jarvis/i)
  })
  test(`${name}: doesn't deny the deed and permit lookups`, () => {
    assert.doesNotMatch(text, /no(?:t| live)? public[- ]records|public[- ]records access|(?:don't|do not) have (?:live |any )?public[- ]records|doesn't reach into|can't (?:read|reach|see|check) (?:the )?(?:public|city|deed) records/i)
  })
  test(`${name}: the feel standard (calm, short, no em-dash, no "I'm afraid")`, () => {
    assert.doesNotMatch(text, /[—–!]|I'm afraid|I am afraid|\bsorry\b|happy to help/i)
    const sentences = text.split(/(?<=[.?])\s+/).filter(Boolean)
    assert.ok(sentences.length >= 1 && sentences.length <= 5, `${sentences.length} sentences: ${text}`)
    assert.ok(text.length <= 420, `${text.length} characters`)
  })
}

test('the public-records reply offers the deed and permit lookups and is honest about the rest', () => {
  assert.match(CANNED_PUBLIC_RECORDS, /deed and permit records/)
  assert.match(CANNED_PUBLIC_RECORDS, /exact address/)
  assert.match(CANNED_PUBLIC_RECORDS, /other websites/)
  assert.match(CANNED_PUBLIC_RECORDS, /couldn't (?:confirm|verify)/)
})

test('the self-description is Drift\'s, with what it can and can\'t do (DRIFT_SCRIPT #2)', () => {
  assert.match(CANNED_SELF_DESCRIPTION, /^I'm Drift, DealFlow's assistant\./)
  for (const can of [/listings/, /buyer and renter requests/, /Buyer Match reports/, /draft emails and texts/, /deed and permit records/, /mortgage rate/]) {
    assert.match(CANNED_SELF_DESCRIPTION, can)
  }
  assert.match(CANNED_SELF_DESCRIPTION, /can't send anything/)
  assert.match(CANNED_SELF_DESCRIPTION, /browse other websites/)
})

test('the generic reply says it couldn\'t verify that part (Q18 target)', () => {
  assert.match(CANNED_GENERIC, /couldn't verify part of/)
})

test('PR 2\'s fixed never-sent reply is unchanged', () => {
  assert.equal(NEVER_SENT_REPLY, "I can't send anything. The draft is ready for you to copy.")
})

// ── The rewrite instruction (retry.ts) ───────────────────────────────────────
test('the rewrite instruction no longer tells Drift to deny public records', () => {
  const p = buildFeedbackPrompt(formatFlagLines([{ pattern: 'real_estate_source_citation', match: 'ACRIS' }], []))
  assert.ok(p.includes("Structural: 'ACRIS' (real_estate_source_citation)"))
  assert.match(p, /Regenerate the response/)
  assert.doesNotMatch(p, /this system doesn't have that data|public records, MLS/)
  // It says what's allowed: restate the record blocks, name a source only when fetched.
  assert.match(p, /record blocks/)
  assert.match(p, /never write a URL/)
  assert.match(p, /one short sentence/)
})

test('the rewrite instruction keeps PR 2\'s never-sent part', () => {
  const p = buildFeedbackPrompt(formatFlagLines([{ pattern: 'action_claim', match: 'Sent' }], []))
  assert.match(p, /Nothing was sent/)
})

// ── The fact-check's description of Drift (llmVerifier.ts:55) ────────────────
test('the fact-check knows Drift looks up deed and permit records, with no tool names', () => {
  const line = VERIFIER_SYSTEM_PROMPT.split('\n').find(l => l.startsWith("- Descriptions of the assistant's OWN capabilities"))
  assert.ok(line, 'the capabilities line is still there')
  assert.doesNotMatch(line, /search_listings|search_parties|cannot send email or read public records/)
  assert.match(line, /deed and permit records/)
  assert.match(line, /can't send anything/)
})

test('the fact-check treats "I can\'t check Zillow" as a decline, not a citation', () => {
  assert.match(VERIFIER_SYSTEM_PROMPT, /I can't check Zillow/)
  assert.match(VERIFIER_SYSTEM_PROMPT, /decline, not a citation/)
})

// ── Q32: a fact-check that fails is logged, not a stock reply ────────────────
function fakeClient(text: string | null, throwErr?: string): VerifierClient {
  return {
    messages: {
      create: async () => {
        if (throwErr) throw new Error(throwErr)
        return { content: text == null ? [] : [{ type: 'text', text }], usage: { input_tokens: 500, output_tokens: 40 } }
      },
    },
  } as unknown as VerifierClient
}

test('§4 table: a verifier API error passes the reply, with a log flag', async () => {
  const r = await verifyResponse('q', [], null, 'Two fit.', { client: fakeClient(null, 'overloaded') })
  assert.equal(r.isGrounded, true)
  assert.deepEqual(r.flags, [])
  assert.equal(r.error, 'verifier_api_error')
  assert.equal(r.costUsd, 0)
})

test('an unreadable answer passes the reply, with a log flag', async () => {
  const r = await verifyResponse('q', [], null, 'Two fit.', { client: fakeClient('I think this looks mostly fine.') })
  assert.equal(r.isGrounded, true)
  assert.deepEqual(r.flags, [])
  assert.equal(r.error, 'verifier_parse_error')
  assert.ok(r.costUsd > 0, 'the call was still paid for')
})

test('an empty answer (no text block) passes the reply, with a log flag', async () => {
  const r = await verifyResponse('q', [], null, 'Two fit.', { client: fakeClient(null) })
  assert.equal(r.isGrounded, true)
  assert.equal(r.error, 'verifier_parse_error')
})

test('the second parse: a cut-off answer still counts its finished flags', async () => {
  const cut = '{"isGrounded": false, "flags": [{"claim": "The owner is Casey Placeholder", "reason": "Not in the ACRIS block."}, {"claim": "sold in 20'
  const r = await verifyResponse('q', [], null, 'The owner is Casey Placeholder.', { client: fakeClient(cut) })
  assert.equal(r.isGrounded, false)
  assert.equal(r.flags[0].claim, 'The owner is Casey Placeholder')
  assert.equal(r.error, undefined)
})

test('the second parse: "not grounded" with its list cut off still asks for a rewrite', async () => {
  const r = await verifyResponse('q', [], null, 'resp', { client: fakeClient('{"isGrounded": false, "flags": [') })
  assert.equal(r.isGrounded, false)
  assert.equal(r.flags.length, 1)
  assert.equal(r.error, undefined)
})

test('the second parse: a cut-off "grounded" answer passes', async () => {
  const r = await verifyResponse('q', [], null, 'resp', { client: fakeClient('{"isGrounded": true, "flags": [') })
  assert.equal(r.isGrounded, true)
  assert.equal(r.error, undefined)
})

test('a normal verdict is unchanged', async () => {
  const ok = await verifyResponse('q', [], null, 'resp', { client: fakeClient('{"isGrounded": true, "flags": []}') })
  assert.deepEqual([ok.isGrounded, ok.flags, ok.error], [true, [], undefined])
  const bad = await verifyResponse('q', [], null, 'resp', { client: fakeClient('{"isGrounded": false, "flags": [{"claim": "x", "reason": "y"}]}') })
  assert.deepEqual([bad.isGrounded, bad.flags.length, bad.error], [false, 1, undefined])
})

test('the guard log row says the fact-check failed on a clean pass', async () => {
  const { summarizeReason, deriveVerdict } = await import('../instrumentation')
  const t: GuardTelemetry = {
    enabled: true, finalAttempt: 0, fellbackToCanned: false, totalVerifierCostUsd: 0,
    history: [{ attempt: 0, regexFlags: [], verifierFlags: [], verifierCost: 0, verifierError: 'verifier_api_error' }],
  }
  assert.equal(deriveVerdict(t), 'pass')
  assert.match(summarizeReason(t), /verifier_api_error/)
  // And says nothing on an ordinary clean pass.
  assert.equal(summarizeReason({ ...t, history: [{ attempt: 0, regexFlags: [], verifierFlags: [], verifierCost: 0 }] }), '')
})

test('route: the attempt records the fact-check error', () => {
  const src = readFileSync(join(__dirname, '../../../../app/api/chat/route.ts'), 'utf8')
  assert.match(src, /if \(verifier\.error\) guardHistory\[guardHistory\.length - 1\]\.verifierError = verifier\.error/)
})

// ── Links show as buttons (T-11; route.ts:86 at f90b19c) ─────────────────────
test('the prompt no longer asks for StreetEasy URLs in the text', () => {
  assert.doesNotMatch(SYSTEM_PROMPT, /verbatim www\.streeteasy\.com URLs/)
  assert.doesNotMatch(SYSTEM_PROMPT, /include its .*URLs/)
})

test('the prompt says links show as buttons and never to write a URL', () => {
  assert.match(SYSTEM_PROMPT, /Never write a URL/)
  assert.match(SYSTEM_PROMPT, /buttons/)
  assert.match(SYSTEM_PROMPT, /Search StreetEasy button/)
})

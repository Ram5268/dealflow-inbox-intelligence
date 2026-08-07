import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_GUARD_RETRIES,
  selectCannedFallback,
  CANNED_PUBLIC_RECORDS,
  CANNED_FINANCE,
  CANNED_SELF_DESCRIPTION,
  CANNED_GENERIC,
  formatFlagLines,
  buildFeedbackPrompt,
} from '../retry'
import type { RegexFlag } from '../regexGuard'
import type { VerifierFlag } from '../llmVerifier'

// Run: `npm test` (ts-node via node:test). Pure helpers — no API calls.

const rx = (pattern: string, match: string): RegexFlag => ({ pattern, match })
const vf = (claim: string, reason = ''): VerifierFlag => ({ claim, reason })

// ── Brief 5.1.1, Fix 3 — contextual fallback selection ───────────────────────
test('ACRIS / external-source flag → public-records fallback', () => {
  assert.equal(
    selectCannedFallback({ regexFlags: [rx('real_estate_source_citation', 'ACRIS')], verifierFlags: [] }),
    CANNED_PUBLIC_RECORDS,
  )
})

test('ownership flag → public-records fallback', () => {
  assert.equal(
    selectCannedFallback({ regexFlags: [], verifierFlags: [vf('461 SIXTH STREET HOLDINGS LLC', 'ownership entity not in tool results')] }),
    CANNED_PUBLIC_RECORDS,
  )
})

test('cap rate flag → finance fallback', () => {
  assert.equal(
    selectCannedFallback({ regexFlags: [], verifierFlags: [vf('cap rate is 5.8%', 'no NOI/cap rate data in tool results')] }),
    CANNED_FINANCE,
  )
})

test('mansion tax flag → finance fallback', () => {
  assert.equal(
    selectCannedFallback({ regexFlags: [], verifierFlags: [vf('mansion tax would be $585,000', 'no tax data in tool results')] }),
    CANNED_FINANCE,
  )
})

test('capabilities / self-description flag → self-description fallback', () => {
  assert.equal(
    selectCannedFallback({ regexFlags: [], verifierFlags: [vf('describes its own capabilities', 'meta discussion')] }),
    CANNED_SELF_DESCRIPTION,
  )
})

test('Mojo / inbox self-description flag → self-description fallback', () => {
  assert.equal(
    selectCannedFallback({ regexFlags: [], verifierFlags: [vf('reads your inbox and Mojo CRM leads', 'self description')] }),
    CANNED_SELF_DESCRIPTION,
  )
})

test('empty flags → generic fallback', () => {
  assert.equal(selectCannedFallback({ regexFlags: [], verifierFlags: [] }), CANNED_GENERIC)
})

test('unrelated flag text → generic fallback', () => {
  assert.equal(
    selectCannedFallback({ regexFlags: [], verifierFlags: [vf('the view is spectacular', 'subjective')] }),
    CANNED_GENERIC,
  )
})

// Priority: a public-records signal wins even when finance words co-occur.
test('mixed ACRIS + cap rate → public-records wins (priority order)', () => {
  assert.equal(
    selectCannedFallback({
      regexFlags: [rx('real_estate_source_citation', 'ACRIS')],
      verifierFlags: [vf('cap rate 5%', 'no data')],
    }),
    CANNED_PUBLIC_RECORDS,
  )
})

// ── Regression: existing pure helpers still behave ───────────────────────────
test('formatFlagLines labels structural vs semantic', () => {
  const lines = formatFlagLines([rx('external_url', 'http://x.com')], [vf('made-up sqft', 'not in tools')])
  assert.deepEqual(lines, [
    "Structural: 'http://x.com' (external_url)",
    "Semantic: 'made-up sqft' — not in tools",
  ])
})

test('buildFeedbackPrompt embeds the flag lines', () => {
  const p = buildFeedbackPrompt(["Structural: 'http://x.com' (external_url)"])
  assert.ok(p.includes("Structural: 'http://x.com' (external_url)"))
  assert.ok(p.includes('Regenerate the response'))
})

// ── Brief 5.1.2 Gate 3, Step 4c — retry loop is bounded ──────────────────────
// The actual loop lives in app/api/chat/route.ts (it needs the live Anthropic
// client). This pins the invariant it depends on, using the REAL exported
// MAX_GUARD_RETRIES + selectCannedFallback: a response that trips the guard on
// EVERY attempt must terminate at MAX_GUARD_RETRIES (no infinite loop) and land
// on the canned fallback — never an unbounded regenerate.
test('Gate3/4c: retry loop is bounded and falls back to canned when every attempt flags', () => {
  // Verifier stub that flags on every attempt (never grounded).
  const alwaysFlags = () => ({
    regexFlags: [] as ReturnType<typeof rx>[],
    verifierFlags: [vf('invented cap rate 5.8%', 'no NOI/cap rate in tool results')],
  })

  let attempt = 0
  let attemptsRun = 0
  let fellback = false
  let finalText: string | null = null
  const history: Array<{ regexFlags: RegexFlag[]; verifierFlags: VerifierFlag[] }> = []

  // Mirrors route.ts: while (attempt <= MAX_GUARD_RETRIES) { scan; if clean break; attempt++; if exhausted -> canned }
  while (attempt <= MAX_GUARD_RETRIES) {
    const flags = alwaysFlags()
    history.push(flags)
    attemptsRun++
    const grounded = flags.regexFlags.length === 0 && flags.verifierFlags.length === 0
    if (grounded) break
    attempt++
    if (attempt > MAX_GUARD_RETRIES) {
      const last = history[history.length - 1]
      finalText = selectCannedFallback({ regexFlags: last.regexFlags, verifierFlags: last.verifierFlags })
      fellback = true
      break
    }
    // guard against a runaway test loop if the invariant ever breaks
    assert.ok(attemptsRun <= MAX_GUARD_RETRIES + 1, 'loop exceeded MAX_GUARD_RETRIES+1 — not bounded')
  }

  assert.equal(attemptsRun, MAX_GUARD_RETRIES + 1, '1 initial attempt + MAX_GUARD_RETRIES retries')
  assert.equal(fellback, true, 'exhausted retries must fall back to canned')
  assert.equal(finalText, CANNED_FINANCE, 'cap-rate flag routes to the finance canned variant')
})

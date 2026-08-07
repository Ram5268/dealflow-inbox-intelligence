import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
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

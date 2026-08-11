import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateMojoContact } from '../validate'

// Run: `npm test` (ts-node via node:test). Pure functions — no I/O, deterministic.

// ── Hard reject: every header-keyword variant ────────────────────────────────
for (const header of ['Full Name', 'Contact Name', 'Name', 'First Last']) {
  test(`header keyword "${header}" is rejected`, () => {
    const r = validateMojoContact({ fullName: header })
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.reason, 'header_row_keyword')
  })
}

test('header keyword is case/space-insensitive', () => {
  const r = validateMojoContact({ fullName: '  full name ' })
  assert.equal(r.ok, false)
})

test('a real name is NOT a header row', () => {
  const r = validateMojoContact({ fullName: 'Jane Doe', email: 'jane@example.com' })
  assert.equal(r.ok, true)
  if (r.ok) assert.deepEqual(r.warnings, [])
})

// ── Soft warnings (log-only, never reject) ───────────────────────────────────
test('valid email passes with no warning', () => {
  const r = validateMojoContact({ fullName: 'Jane Doe', email: 'jane@example.com' })
  assert.equal(r.ok, true)
  if (r.ok) assert.ok(!r.warnings.includes('invalid_email_format'))
})

test('invalid email warns but does not reject', () => {
  const r = validateMojoContact({ fullName: 'Jane Doe', email: 'not-an-email' })
  assert.equal(r.ok, true)
  if (r.ok) assert.ok(r.warnings.includes('invalid_email_format'))
})

test('name containing @ warns', () => {
  const r = validateMojoContact({ fullName: 'jane@doe' })
  assert.equal(r.ok, true)
  if (r.ok) assert.ok(r.warnings.includes('name_contains_at'))
})

test('short name warns', () => {
  const r = validateMojoContact({ fullName: 'Jo' })
  assert.equal(r.ok, true)
  if (r.ok) assert.ok(r.warnings.includes('name_too_short'))
})

test('city === address warns', () => {
  const r = validateMojoContact({ fullName: 'Jane Doe', city: '123 Main St', address: '123 Main St' })
  assert.equal(r.ok, true)
  if (r.ok) assert.ok(r.warnings.includes('city_equals_address'))
})

// ── Empty / null fields must not crash ───────────────────────────────────────
test('empty payload does not crash', () => {
  const r = validateMojoContact({})
  // fullName '' has length < 3 → warning, but ok
  assert.equal(r.ok, true)
})

test('null fields do not crash', () => {
  const r = validateMojoContact({ fullName: null, email: null, city: null, address: null })
  assert.equal(r.ok, true)
})

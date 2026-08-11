// Brief 7.2 (Fix #4) — cheap, dependency-free validators for inbound Mojo/Zapier
// payloads. One hard reject (CSV header rows that leak through as contacts);
// everything else is a log-only warning that never mutates the data. The
// warnings ride along in MojoContact.metadata.validationWarnings so the audit
// script can surface them without us guessing at "corruption" up front.

export interface MojoPayload {
  fullName?: string | null
  email?: string | null
  address?: string | null
  city?: string | null
  [key: string]: unknown
}

export type ValidationResult =
  | { ok: true; warnings: string[] }
  | { ok: false; reason: string }

// Exact fullName values that mean "this row is a spreadsheet header, not a
// person". These are the literal column labels Mojo/CSV exports emit.
const HEADER_KEYWORDS = new Set(['full name', 'contact name', 'name', 'first last'])

const EMAIL_RE = /.+@.+\..+/

export function validateMojoContact(p: MojoPayload): ValidationResult {
  const fullName = (p.fullName ?? '').toString()
  const email = (p.email ?? '').toString()
  const address = (p.address ?? '').toString()
  const city = (p.city ?? '').toString()

  // ── Hard reject (the only one) ─────────────────────────────────────────────
  if (HEADER_KEYWORDS.has(fullName.trim().toLowerCase())) {
    return { ok: false, reason: 'header_row_keyword' }
  }

  // ── Soft warnings (log-only; never mutate) ─────────────────────────────────
  const warnings: string[] = []

  if (email && !EMAIL_RE.test(email)) warnings.push('invalid_email_format')
  if (fullName.includes('@')) warnings.push('name_contains_at')
  if (fullName.length < 3) warnings.push('name_too_short')
  if (city && address && city === address) warnings.push('city_equals_address')

  return { ok: true, warnings }
}

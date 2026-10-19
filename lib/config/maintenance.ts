import { safeEqual } from '../auth/safeEqual'

// Brief 41 (H6) — one fail-closed switch for the maintenance routes:
// sync/reextract, sync/reclassify, sync/hotsheet, sync/embed-all,
// admin/backfill-hotsheets and (Brief 48) sync/reprocess-attachments. They
// delete or rewrite listings or saved email attachment text, or run up OpenAI,
// Anthropic and ScrapingBee bills, and nothing in the app calls them. They are
// off unless MAINTENANCE_ENABLED is exactly 'true'. An off-switch, not a login.
export function maintenanceEnabled(): boolean {
  return process.env.MAINTENANCE_ENABLED === 'true'
}

export const MAINTENANCE_OFF_BODY = {
  ok: false,
  error: 'Maintenance routes are switched off. Set MAINTENANCE_ENABLED=true in Vercel to run one.',
} as const

// The ADMIN_SECRET check on admin/backfill-hotsheets. Fails closed: with no
// secret configured nothing gets through (it used to let everyone through).
// Brief 48 (PR 6): the compare hashes both sides first (safeEqual), so the
// timing doesn't reveal the secret's length [engineering precaution].
export function adminSecretOk(provided: unknown, secret: string | undefined): boolean {
  if (!secret || typeof provided !== 'string') return false
  return safeEqual(provided, secret)
}

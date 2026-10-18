import { createHash, timingSafeEqual } from 'crypto'

// Brief 41.2 (PR C) — the token check for POST /api/instantly/webhook, which
// used to accept anything. Engineering precaution from the Oct 16, 2026
// system-map review. Instantly's API v2 webhooks can send custom headers (the
// webhook's `headers` field), so the token travels in the header only, never
// in the URL:
//   Authorization: Bearer <INSTANTLY_WEBHOOK_SECRET>
// Both sides are hashed (SHA-256) before the constant-time compare, so the
// compare takes the same time whatever the token's content or length.
//
// 503 when no secret is set (unset, empty or blank), so nothing gets through.
// 401 on a missing or wrong token. 200 on the exact token.
export function checkInstantlyWebhookToken(authorization: string | null, secret: string | undefined): 200 | 401 | 503 {
  if (!secret?.trim()) return 503
  const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest()
  return timingSafeEqual(sha256(authorization ?? ''), sha256(`Bearer ${secret}`)) ? 200 : 401
}

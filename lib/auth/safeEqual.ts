import { createHash, timingSafeEqual } from 'crypto'

// Brief 48 (PR 6, item 4.17): the constant-time key compare for
// checkCronBearer and adminSecretOk [engineering precaution, from the Brief 46
// checkup]. Both sides are hashed (SHA-256) first, so timingSafeEqual always
// compares two 32-byte digests: there is no early return when the lengths
// differ, and the timing reveals nothing about the key's length or content.
// Same pattern as lib/auth/instantlyWebhook.ts.
//
// Fails closed on an empty expected value, so a caller that forgets to refuse
// an unset secret first (safeEqual(header ?? '', process.env.X ?? '')) still
// lets nothing through. That branch depends only on the server's own setting,
// never on the guess, so it reveals nothing [engineering precaution].
export function safeEqual(provided: string, expected: string): boolean {
  if (!expected) return false
  const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest()
  return timingSafeEqual(sha256(provided), sha256(expected))
}

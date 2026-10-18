import { createHash, timingSafeEqual } from 'crypto'
import type { PrismaClient } from '@prisma/client'

// Brief 44 §5 (engineering precaution): POST /api/valuations/import and GET
// /api/valuations/targets accept only `Authorization: Bearer <key>` whose SHA-256
// matches the fingerprint in ServiceKey 'valuation-import'. The key itself lives
// only in GitHub's secret store (VALUATION_IMPORT_SECRET); DealFlow keeps just its
// fingerprint, and no Vercel setting is involved. Fails closed:
//   - a header that isn't exactly "Bearer " plus 32-256 key characters: 401;
//   - no ServiceKey row, a stored fingerprint that isn't 64 lowercase hex
//     characters, or a database error: 503 not_configured;
//   - a key whose SHA-256 differs: 401. Both sides are 32-byte digests, so the
//     constant-time compare reveals nothing about the key's length.
// The routes call it before reading the request body. The token is never logged or echoed.

export const SERVICE_KEY_ID = 'valuation-import'
// The key's characters and length, also for scripts/valuation-service-key.ts.
export const KEY_PATTERN = /^[A-Za-z0-9._~+/=-]{32,256}$/
const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{32,256})$/
const FINGERPRINT = /^[0-9a-f]{64}$/

export const sha256Hex = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex')

export type ServiceKeyCheck = 200 | 401 | 503

export async function checkServiceKey(db: Pick<PrismaClient, 'serviceKey'>, authorization: string | null): Promise<ServiceKeyCheck> {
  const token = BEARER.exec(authorization ?? '')?.[1]
  if (!token) return 401
  let stored: string | undefined
  try {
    stored = (await db.serviceKey.findUnique({ where: { id: SERVICE_KEY_ID }, select: { sha256: true } }))?.sha256
  } catch (e) {
    console.error('[valuations] service key lookup failed:', (e as { code?: unknown }).code ?? (e as Error).name)
    return 503
  }
  if (!stored || !FINGERPRINT.test(stored)) {
    console.error(`[valuations] ServiceKey '${SERVICE_KEY_ID}' is ${stored == null ? 'missing' : 'malformed'}: refusing`)
    return 503
  }
  const got = createHash('sha256').update(token, 'utf8').digest()
  return timingSafeEqual(got, Buffer.from(stored, 'hex')) ? 200 : 401
}

// The body a refused request gets.
export const refusalBody = (status: 401 | 503) =>
  status === 503 ? { ok: false, error: 'not_configured' } : { ok: false, error: 'unauthorized' }

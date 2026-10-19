import crypto from 'crypto'
import { z } from 'zod'
import { ORG_SLUG } from '../crm-sync/runSync'

// Brief 45 (PR E): who may ask DealFlow to score one CRM upload's new leads
// (POST /api/crm/score-import, CONTRACT §7). There is no shared secret and no
// Vercel setting [engineering precaution]: when an upload finishes, the CRM
// makes a fresh random token, stores only its SHA-256 on the ImportBatch row,
// and sends the token here. DealFlow reads that row through its read-only CRM
// link and checks, in this order:
//   1. the import exists in Ryan's organization       else 404 not_found
//   2. the token's SHA-256 equals the stored hash     else 403 bad_token
//   3. the import is completed                         else 403 not_completed
//   4. it finished less than 60 minutes ago, and not
//      more than 5 minutes in the future (clock skew)  else 403 expired
//   5. it isn't marked scored yet                      else 403 already_scored
// The token is checked before any state, so a caller without it learns
// nothing about the import's progress. Pure: no I/O.

// The CRM sends at most 500 leads per request (one chunk) [engineering
// precaution: a chunk must finish inside Vercel's 300-second limit].
export const MAX_LEADS_PER_REQUEST = 500
export const SCORE_WINDOW_MS = 60 * 60 * 1000
// How far ahead of DealFlow's clock the CRM's may run [engineering precaution].
export const CLOCK_SKEW_MS = 5 * 60 * 1000

const ID = /^[A-Za-z0-9_-]{1,64}$/
const scoreImportBody = z.strictObject({
  importId: z.string().regex(ID),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), // 32 random bytes, base64url
  leadIds: z.array(z.string().regex(ID)).min(1).max(MAX_LEADS_PER_REQUEST)
    .refine(ids => new Set(ids).size === ids.length, 'lead ids must be unique'),
})
export type ScoreImportRequest = z.infer<typeof scoreImportBody>

// null: not the contract's body (the route answers 400 invalid_request).
export function parseScoreImportBody(raw: unknown): ScoreImportRequest | null {
  const parsed = scoreImportBody.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export const sha256Hex = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

// Constant-time comparison of the two 32-byte digests. A missing or malformed
// stored hash never matches.
export function tokenMatches(token: string, storedHash: string | null | undefined): boolean {
  const stored = (storedHash ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(stored)) return false
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(token, 'utf8').digest(), Buffer.from(stored, 'hex'))
}

// The ImportBatch row as the CRM read returns it (lib/importScoring/crmRead.ts).
export interface ImportBatchState {
  orgSlug: string
  status: string
  completedAt: Date | null
  tokenHash: string | null
  scoredAt: Date | null
}

export type RefusalCode = 'invalid_request' | 'not_found' | 'bad_token' | 'not_completed' | 'expired' | 'already_scored'
export interface Refusal { status: 400 | 403 | 404; error: RefusalCode }

// null: go ahead.
export function checkImportBatch(batch: ImportBatchState | null, token: string, now: Date): Refusal | null {
  if (!batch || batch.orgSlug !== ORG_SLUG) return { status: 404, error: 'not_found' }
  if (!tokenMatches(token, batch.tokenHash)) return { status: 403, error: 'bad_token' }
  if (batch.status !== 'completed') return { status: 403, error: 'not_completed' }
  // "Finished less than 60 minutes ago" (brief §5.8): exactly 60 minutes is too
  // late, and a completed import with no completion time can't be shown recent.
  // A completion more than 5 minutes in the future is more than clock skew, so
  // it can't be shown recent either [engineering precaution].
  const age = batch.completedAt ? now.getTime() - batch.completedAt.getTime() : NaN
  if (!(age < SCORE_WINDOW_MS && age >= -CLOCK_SKEW_MS)) return { status: 403, error: 'expired' }
  if (batch.scoredAt) return { status: 403, error: 'already_scored' }
  return null
}

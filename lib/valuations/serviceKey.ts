import type { PrismaClient } from '@prisma/client'
import { KEY_PATTERN, SERVICE_KEY_ID, sha256Hex } from './auth'

// Brief 44 data step V2 (scripts/valuation-service-key.ts): stores the SHA-256
// fingerprint of the valuation job's import key in ServiceKey 'valuation-import'.
// The parts that need no database live here, so they're tested without one.
// Engineering precaution (Brief 44 §4): the key arrives on stdin only (never on the
// command line or in the environment), is never stored, and neither it nor its
// fingerprint is ever printed, in any mode or on any error.

// More than this on stdin isn't a key.
export const MAX_STDIN_BYTES = 4096

export const KEY_REFUSED =
  'Refused: pipe the key in on stdin (32-256 characters: A-Z a-z 0-9 . _ ~ + / = -, one trailing newline is fine). ' +
  'Nothing was written, and what was given is not shown.'

// The key from what was piped in: one trailing newline (from echo) is dropped, and
// anything that isn't then 32-256 key characters is refused. null: nothing was piped
// (a terminal, where a typed key would show on screen) or more than MAX_STDIN_BYTES.
export function keyFromStdin(raw: string | null): string | null {
  if (raw == null) return null
  const key = raw.endsWith('\n') ? raw.slice(0, -1) : raw
  return KEY_PATTERN.test(key) ? key : null
}

export interface StoreOutcome {
  exitCode: number
  message: string // safe to print: never the key or its fingerprint
}

// A dry run (apply false) only reads whether the row exists. With apply it creates
// the row, or rotates it: a new fingerprint and rotatedAt = now.
export async function storeServiceKey(db: Pick<PrismaClient, 'serviceKey'>, key: string, apply: boolean, now = new Date()): Promise<StoreOutcome> {
  try {
    const existing = await db.serviceKey.findUnique({ where: { id: SERVICE_KEY_ID }, select: { id: true } })
    if (!apply) {
      return {
        exitCode: 0,
        message: `Dry run: would ${existing ? 'rotate' : 'create'} ServiceKey '${SERVICE_KEY_ID}'. Nothing was written. Re-run with --apply to write it.`,
      }
    }
    const sha256 = sha256Hex(key)
    await db.serviceKey.upsert({
      where: { id: SERVICE_KEY_ID },
      create: { id: SERVICE_KEY_ID, sha256 },
      update: { sha256, rotatedAt: now },
    })
    return { exitCode: 0, message: `${existing ? 'Rotated' : 'Created'} ServiceKey '${SERVICE_KEY_ID}' (fingerprint only; the key is not stored).` }
  } catch (e) {
    // Only an error code or class name: a message could quote the query.
    const code = (e as { code?: unknown }).code
    const what = typeof code === 'string' && /^[A-Z0-9_]{1,16}$/.test(code) ? code : e instanceof Error ? e.constructor.name : 'unknown'
    return { exitCode: 1, message: `Failed (${what}). Nothing about the key is printed.` }
  }
}

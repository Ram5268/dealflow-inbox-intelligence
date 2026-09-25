import { randomUUID } from 'crypto'
import { phoneKey } from './mapLead'
import { appendNew, type SyncPlan } from './plan'

// Brief 34: SQL for the CRM lead sync. Each statement takes its rows as ONE
// jsonb parameter (jsonb_to_recordset), so a 500-row chunk never approaches
// Prisma's 32,766-value limit.
//
// Keep-old rule for existing rows, by column mode:
//   fill    COALESCE(old, new): a blank gets filled, a value is never replaced
//   append  phone/email lists: the new list applies only if the old one is its prefix
//   merge   metadata: COALESCE(old, '{}') || new
//   insert  written only when the row is created (neighborhood)
type Mode = 'fill' | 'append' | 'merge' | 'insert'
export const COLUMNS: [name: string, type: string, mode: Mode][] = [
  ['fullName', 'text', 'fill'], ['coOwnerFullName', 'text', 'fill'],
  ['phone', 'text', 'fill'], ['additionalPhones', 'text[]', 'append'],
  ['email', 'text', 'fill'], ['additionalEmails', 'text[]', 'append'],
  ['address', 'text', 'fill'], ['city', 'text', 'fill'], ['state', 'text', 'fill'], ['zipCode', 'text', 'fill'],
  ['neighborhood', 'text', 'insert'], ['propertyTypeDetail', 'text', 'fill'], ['unitCount', 'int', 'fill'],
  ['propertyBeds', 'float8', 'fill'], ['propertyBaths', 'float8', 'fill'], ['buildingSqft', 'float8', 'fill'],
  ['yearBuilt', 'int', 'fill'], ['lastSaleDate', 'timestamp', 'fill'], ['alternateAddress', 'text', 'fill'],
  ['ownerOccupied', 'boolean', 'fill'], ['lastDialDate', 'timestamp', 'fill'], ['lastCalled', 'timestamp', 'fill'],
  ['mojoList', 'text', 'fill'], ['status', 'text', 'fill'], ['notes', 'text', 'fill'], ['metadata', 'jsonb', 'merge'],
]
const UPDATED = COLUMNS.filter(([, , mode]) => mode !== 'insert')

const q = (c: string) => `"${c}"`
function updateExpr(c: string, mode: Mode): string {
  const old = `m.${q(c)}`, next = `EXCLUDED.${q(c)}`
  if (mode === 'append') return `CASE WHEN COALESCE(${old}, '{}') = ${next}[1:cardinality(COALESCE(${old}, '{}'))] THEN ${next} ELSE ${old} END`
  if (mode === 'merge') return `COALESCE(${old}, '{}'::jsonb) || ${next}`
  return `COALESCE(${old}, ${next})`
}
const snapshot = (alias: string) => `jsonb_build_object(${UPDATED.map(([c]) => `'${c}', ${alias}.${q(c)}`).join(', ')})`

// $1 = jsonb array of rows, $2 = organizationId. RETURNING old/new needs Postgres 18.
export const UPSERT_SQL = `
WITH src AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(id text, "mojoId" text, ${COLUMNS.map(([c, t]) => `${q(c)} ${t}`).join(', ')})
)
INSERT INTO "MojoContact" AS m (id, "mojoId", "organizationId", intent, "isTestData", "updatedAt", ${COLUMNS.map(([c]) => q(c)).join(', ')})
SELECT id, "mojoId", $2, 'SELLER', false, now(), ${COLUMNS.map(([c]) => q(c)).join(', ')} FROM src
ON CONFLICT ("mojoId") DO UPDATE SET "updatedAt" = now(), ${UPDATED.map(([c, , mode]) => `${q(c)} = ${updateExpr(c, mode)}`).join(', ')}
WHERE NOT m."isTestData" AND m."organizationId" = EXCLUDED."organizationId"
  AND (${UPDATED.map(([c, , mode]) => updateExpr(c, mode)).join(', ')}) IS DISTINCT FROM (${UPDATED.map(([c]) => `m.${q(c)}`).join(', ')})
RETURNING new."mojoId", old.id IS NULL AS inserted, ${snapshot('old')} AS before, ${snapshot('new')} AS after`

// $1 = jsonb [{id, old_id, new_id}]: csv keepers take the CRM mojoId.
export const REKEY_SQL = `
UPDATE "MojoContact" AS m SET "mojoId" = v.new_id, "updatedAt" = now()
FROM jsonb_to_recordset($1::jsonb) AS v(id text, old_id text, new_id text)
WHERE m.id = v.id AND m."mojoId" = v.old_id AND NOT m."isTestData"`

// $1 = jsonb [{id, keeper_id}]: only metadata changes; rows are never deleted.
export const DUPLICATES_SQL = `
UPDATE "MojoContact" AS m
SET metadata = COALESCE(m.metadata, '{}'::jsonb) || jsonb_build_object('source', 'duplicate', 'duplicateOf', v.keeper_id)
FROM jsonb_to_recordset($1::jsonb) AS v(id text, keeper_id text)
WHERE m.id = v.id AND NOT m."isTestData"
  AND (m.metadata->>'source', m.metadata->>'duplicateOf') IS DISTINCT FROM ('duplicate', v.keeper_id)`

// $1 = organizationId. Real rows no CRM lead claimed.
export const LEGACY_SQL = `
UPDATE "MojoContact" SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"source":"legacy"}'::jsonb
WHERE "organizationId" = $1 AND NOT "isTestData" AND metadata->>'source' IS NULL`

// $1 = organizationId, $2 = jsonb array of every mojoId the CRM returned.
export const REMOVED_SQL = `
UPDATE "MojoContact" SET metadata = metadata || '{"source":"crm_removed"}'::jsonb
WHERE "organizationId" = $1 AND NOT "isTestData" AND metadata->>'source' = 'crm'
  AND "mojoId" NOT IN (SELECT jsonb_array_elements_text($2::jsonb))`

export function toUpsertRow({ contact, keeper }: SyncPlan['upserts'][number]) {
  const { phones, emails, ...fields } = contact
  const p = appendNew(keeper?.phone ?? null, keeper?.additionalPhones ?? null, phones, phoneKey)
  const e = appendNew(keeper?.email ?? null, keeper?.additionalEmails ?? null, emails, s => s.toLowerCase())
  // A keeper's own id: if it ever missed the mojoId conflict, the insert fails
  // on the primary key instead of creating a second record.
  return { ...fields, id: keeper?.id ?? randomUUID(), phone: p.first, additionalPhones: p.rest, email: e.first, additionalEmails: e.rest }
}

export interface UpsertReturn { mojoId: string; inserted: boolean; before: Record<string, unknown>; after: Record<string, unknown> }

const blank = (v: unknown) => v == null || (Array.isArray(v) && v.length === 0)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// Per-column counts of blanks filled on updated rows, and every existing
// non-blank value that changed. That list must stay empty under the keep-old
// rule, and runSync rolls back if it isn't.
export function diffUpdates(rows: UpsertReturn[]): { filled: Record<string, number>; changed: string[] } {
  const filled: Record<string, number> = {}
  const changed: string[] = []
  for (const { mojoId, inserted, before, after } of rows) {
    if (inserted) continue
    for (const [c] of UPDATED) {
      const b = before[c], a = after[c]
      if (c === 'metadata') continue
      if (blank(b)) { if (!blank(a)) filled[c] = (filled[c] ?? 0) + 1 }
      else if (Array.isArray(b) ? !Array.isArray(a) || !same(b, a.slice(0, b.length)) : !same(b, a)) changed.push(`${mojoId}.${c}`)
    }
  }
  return { filled, changed }
}

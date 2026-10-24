// Brief 48 (data steps): the database side of the data-step scripts. Raw SQL
// only, so no write goes through Prisma's @updatedAt (a restored row is exactly
// the row that was removed). Table and column names come from the allowlists
// below, never from input; values always travel as one jsonb parameter.
// Engineering precaution throughout (see lib/dataSteps/common.ts).
import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { DataStepRefusal, type Row } from './common'

export type Tx = Prisma.TransactionClient

// Tables a data step may read whole rows from, delete from or insert into.
export const TABLES = [
  'MojoContact', 'ExtractedOpportunity', 'Match', 'MatchDismissal', 'CallQueueEntry',
  'CallLog', 'InstantlyEvent', 'OutcomeFeedback',
] as const
export type Table = (typeof TABLES)[number]

// Columns a data step may change, with their SQL types. Every change to a
// table names all of its columns here (from = to where one isn't changed).
export const CHANGE_COLUMNS: Partial<Record<Table, Record<string, string>>> = {
  MatchDismissal: { partyId: 'text', listingId: 'text' },
  CallQueueEntry: { primaryMatchId: 'text', contributingMatchIds: 'text[]' },
  CallLog: { contactId: 'text' },
  InstantlyEvent: { contactId: 'text' },
  OutcomeFeedback: { opportunityId: 'text', matchId: 'text' },
}

export function assertTable(t: string): asserts t is Table {
  if (!(TABLES as readonly string[]).includes(t)) throw new DataStepRefusal(`Refusing: "${t}" isn't a table this data step handles. Nothing changed.`)
}

export const json = (x: unknown) => JSON.stringify(x)
export const inIds = (n: number) => `IN (SELECT jsonb_array_elements_text($${n}::jsonb))`

const CHUNK = 500
function chunks<T>(xs: readonly T[], n = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

const TX = { maxWait: 10_000, timeout: 600_000 }
// Waits at most 10 s for a lock, and stops any one statement after 5 minutes.
const LIMITS = ["SET LOCAL lock_timeout = '10s'", "SET LOCAL statement_timeout = '300s'"]

// A read-only transaction: any write in it fails. Dry runs and checks use it.
// Brief 48 review: repeatable read, so every count in a dry run comes from one
// snapshot, as the write transaction's re-made plan does.
export async function readOnly<T>(db: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
    for (const s of LIMITS) await tx.$executeRawUnsafe(s)
    return fn(tx)
  }, { ...TX, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
}

// The one write transaction of a run. Repeatable read: if a row it changes is
// changed by someone else meanwhile, it fails and rolls back whole.
// Brief 48 review (engineering precaution): `lock` names tables without a
// foreign key to the rows a step removes (Match, MatchDismissal,
// OutcomeFeedback, the call list's match ids), where another session could add
// a row naming them after this transaction's snapshot. They are locked against
// writes (reads go on) before the first query, so the snapshot is taken after
// the lock and nothing can be added until the commit. A writer holding one of
// them makes this wait at most 10 s, then fail with nothing changed.
export async function writeTransaction<T>(db: PrismaClient, fn: (tx: Tx) => Promise<T>, lock: readonly Table[] = []): Promise<T> {
  return db.$transaction(async tx => {
    for (const s of LIMITS) await tx.$executeRawUnsafe(s)
    if (lock.length) {
      lock.forEach(t => assertTable(t))
      await tx.$executeRawUnsafe(`LOCK TABLE ${lock.map(t => `"${t}"`).join(', ')} IN SHARE ROW EXCLUSIVE MODE`)
    }
    return fn(tx)
  }, { ...TX, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
}

export async function orgIdBySlug(tx: Tx, slug: string): Promise<string> {
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>('SELECT id FROM "Organization" WHERE slug = $1', slug)
  if (rows.length !== 1) throw new DataStepRefusal(`Refusing: no organization "${slug}" in this database. Nothing changed.`)
  return rows[0].id
}

// Whole rows (Postgres to_jsonb), by id, sorted by id.
export async function fetchRows(tx: Tx, table: Table, ids: readonly string[]): Promise<Row[]> {
  assertTable(table)
  const out: Row[] = []
  for (const part of chunks([...new Set(ids)])) {
    const rows = await tx.$queryRawUnsafe<{ row: Row }[]>(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE t.id ${inIds(1)}`, json(part))
    out.push(...rows.map(r => r.row))
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// Deletes exactly these rows (and only where `extraWhere` also holds; its
// values are $2, $3, … from `params`). Any other count fails the transaction.
export async function deleteRows(tx: Tx, table: Table, ids: readonly string[], extraWhere = '', ...params: unknown[]): Promise<number> {
  assertTable(table)
  let n = 0
  for (const part of chunks(ids)) {
    n += await tx.$executeRawUnsafe(`DELETE FROM "${table}" t WHERE t.id ${inIds(1)}${extraWhere ? ` AND (${extraWhere})` : ''}`, json(part), ...params)
  }
  if (n !== ids.length) throw new DataStepRefusal(`Refusing: ${ids.length - n} ${table} row(s) changed since they were read (deleted ${n} of ${ids.length}). Rolled back; nothing changed.`)
  return n
}

// Inserts whole rows as they were (jsonb_populate_recordset gives every column
// its stored value, ids and timestamps included).
export async function insertRows(tx: Tx, table: Table, rows: readonly Row[]): Promise<number> {
  assertTable(table)
  let n = 0
  for (const part of chunks(rows)) {
    n += await tx.$executeRawUnsafe(`INSERT INTO "${table}" SELECT * FROM jsonb_populate_recordset(NULL::"${table}", $1::jsonb)`, json(part))
  }
  if (n !== rows.length) throw new DataStepRefusal(`Refusing: inserted ${n} of ${rows.length} ${table} row(s). Rolled back; nothing changed.`)
  return n
}

export interface Change {
  id: string
  from: Record<string, unknown>
  to: Record<string, unknown>
}

// Sets the table's change columns to `to` on each row whose columns are still
// `from`. Any row that moved on meanwhile fails the transaction.
export async function applyChanges(tx: Tx, table: Table, changes: readonly Change[]): Promise<number> {
  assertTable(table)
  const cols = CHANGE_COLUMNS[table]
  if (!cols) throw new DataStepRefusal(`Refusing: ${table} has no changeable columns. Nothing changed.`)
  const names = Object.keys(cols)
  for (const c of changes) {
    for (const name of names) {
      if (!(name in c.from) || !(name in c.to)) throw new DataStepRefusal(`Refusing: a ${table} change doesn't name ${name}. Nothing changed.`)
    }
  }
  const q = (s: string) => `"${s}"`
  const recordCols = ['id text', ...names.flatMap(n => [`${q(`from_${n}`)} ${cols[n]}`, `${q(`to_${n}`)} ${cols[n]}`])].join(', ')
  const sql = `UPDATE "${table}" AS t SET (${names.map(q).join(', ')}) = ROW(${names.map(n => `v.${q(`to_${n}`)}`).join(', ')})
FROM jsonb_to_recordset($1::jsonb) AS v(${recordCols})
WHERE t.id = v.id AND (${names.map(n => `t.${q(n)}`).join(', ')}) IS NOT DISTINCT FROM (${names.map(n => `v.${q(`from_${n}`)}`).join(', ')})`
  let n = 0
  for (const part of chunks(changes)) {
    const rows = part.map(c => ({ id: c.id, ...Object.fromEntries(names.flatMap(nm => [[`from_${nm}`, c.from[nm]], [`to_${nm}`, c.to[nm]]])) }))
    n += await tx.$executeRawUnsafe(sql, json(rows))
  }
  if (n !== changes.length) throw new DataStepRefusal(`Refusing: ${changes.length - n} ${table} row(s) changed since they were read. Rolled back; nothing changed.`)
  return n
}

// The org's call-list generation ids (the nightly replaces the whole list
// with a new id every night).
export async function callListGenerations(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await tx.$queryRawUnsafe<{ g: string }[]>(
    'SELECT DISTINCT "generationRunId" AS g FROM "CallQueueEntry" WHERE "organizationId" = $1 ORDER BY 1', orgId)
  return rows.map(r => r.g)
}

export async function count(tx: Tx, sql: string, ...params: unknown[]): Promise<number> {
  const [row] = await tx.$queryRawUnsafe<{ n: number }[]>(sql, ...params)
  return row?.n ?? 0
}

// ── Mentions ────────────────────────────────────────────────────────────────
// Logs, chat and reports that mention an id in their text or JSON. Counted,
// never rewritten. Each text is split into tokens (letters and digits; and
// letters, digits, "_" and "-", for ids like uuids), matched against the ids
// with a hash join, so one pass per table however many ids there are.
export interface MentionTarget { label: string; table: string; expr: string }

export const MENTION_TARGETS: readonly MentionTarget[] = [
  { label: 'AuditLog (log entries)', table: 'AuditLog', expr: 't."detailsJson"::text' },
  { label: 'ChatMessage (chat text and saved cards)', table: 'ChatMessage',
    expr: `concat_ws(' ', t.content, t."dealsJson"::text, t.suggestions::text, t."attachedReport"::text, t."attachedFragment"::text)` },
  { label: 'Report (saved reports)', table: 'Report',
    expr: `concat_ws(' ', t.params::text, t.sections::text, t.markdown, t.sources::text, t."buyerId", t."opportunityId")` },
  { label: 'DriftInteraction (cards shown)', table: 'DriftInteraction', expr: `concat_ws(' ', t."topCards"::text, t."parsedFilters"::text)` },
  { label: 'DriftInteractionClick (cards clicked)', table: 'DriftInteractionClick', expr: 't."cardId"' },
  { label: 'GuardFireEvent (chat checks)', table: 'GuardFireEvent',
    expr: `concat_ws(' ', t."toolCallsAttempted"::text, t."assistantAttempt", t."finalResponseSent", t."verifierReason", t."userTurn", t."priorAssistantTurn")` },
  { label: 'ReviewQueueItem.opportunityId', table: 'ReviewQueueItem', expr: 't."opportunityId"' },
  { label: 'AIExtractionLog.opportunityId', table: 'AIExtractionLog', expr: 't."opportunityId"' },
  { label: 'zapier_ingest_log.resultContactId', table: 'zapier_ingest_log', expr: 't."resultContactId"' },
]

export async function countMentions(tx: Tx, ids: readonly string[], targets: readonly MentionTarget[] = MENTION_TARGETS): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of targets) {
    if (ids.length === 0) { out[t.label] = 0; continue }
    out[t.label] = await count(tx, `
WITH ids AS MATERIALIZED (SELECT DISTINCT jsonb_array_elements_text($1::jsonb) AS id)
SELECT count(DISTINCT t.id)::int AS n
FROM "${t.table}" t
CROSS JOIN LATERAL (
  SELECT regexp_split_to_table(${t.expr}, '[^A-Za-z0-9]+')
  UNION ALL SELECT regexp_split_to_table(${t.expr}, '[^A-Za-z0-9_-]+')
) AS s(tok)
JOIN ids ON ids.id = s.tok`, json(ids))
  }
  return out
}

// Records the run in AuditLog: counts and the before-copy's file name only.
export async function auditRow(tx: Tx, orgId: string, action: string, details: Record<string, unknown>): Promise<void> {
  await tx.$executeRawUnsafe(
    'INSERT INTO "AuditLog" (id, action, "detailsJson", "createdAt", "organizationId") VALUES ($1, $2, $3::jsonb, now(), $4)',
    `b48ds-${randomUUID()}`, action, json(details), orgId)
}

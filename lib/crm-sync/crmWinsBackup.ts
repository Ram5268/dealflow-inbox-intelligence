import { join } from 'node:path'
import type { Prisma, PrismaClient } from '@prisma/client'
import { PREIMAGE_DIR_FLAG } from '../privateRecord'
import { COLUMNS } from './upsert'
import { CRM_WINS, parseCrmWinsArgs } from './crmWins'

// Brief 48 (PR 7 review r1; data step DS-4, Brief 48 §4: every data step has a before-copy
// and a restore) [executor, 2026-10-23]. Turning the CRM_WINS switch off stops further
// changes but doesn't undo the ones already made. So `scripts/brief48-crm-wins-switch.ts
// --on --apply` first saves a private before-copy of every column the copy can change, for
// every CRM seller (metadata.source 'crm'; never test data), and `--restore <file>` turns
// the switch off and puts those columns back exactly, in one transaction. The copy's own
// key changes (a re-key to a new Mojo ID) don't come from the switch, so mojoId is saved to
// identify the row but never written back. One exception [engineering precaution, Brief 43
// PR 5]: a do-not-contact mark (metadata.crmOptOut) added since is kept.
// The file holds names, phone numbers and notes: it is written owner-only outside every
// git checkout (lib/privateRecord.ts) and its contents are never printed.

export const BEFORE_COPY_KIND = 'brief48-crm-wins-before-copy'
export const RESTORE_ACTION = 'CRM_WINS_RESTORE'

// Every column the copy writes on an existing seller (not neighborhood: insert only).
export const COPIED_COLUMNS = COLUMNS.filter(([, , mode]) => mode !== 'insert')
const TYPES = new Map(COPIED_COLUMNS.map(([c, t]) => [c, t]))
const q = (c: string) => `"${c}"`

export interface BeforeCopy {
  kind: typeof BEFORE_COPY_KIND
  version: 1
  createdAt: string
  organizationId: string
  columns: string[]
  rows: Array<Record<string, unknown>> // id, mojoId and the columns, as Postgres's jsonb gives them
}

// $1 = organizationId. Exact values: jsonb keeps timestamps, numbers, lists and JSON as they are.
export const BEFORE_COPY_SQL = `
SELECT jsonb_build_object('id', m.id, 'mojoId', m."mojoId", ${COPIED_COLUMNS.map(([c]) => `'${c}', m.${q(c)}`).join(', ')}) AS row
FROM "MojoContact" m
WHERE m."organizationId" = $1 AND NOT m."isTestData" AND m.metadata->>'source' = 'crm'
ORDER BY m.id`

export async function readBeforeCopy(db: Pick<PrismaClient, '$queryRawUnsafe'>, organizationId: string, now = new Date()): Promise<BeforeCopy> {
  const rows = (await db.$queryRawUnsafe<{ row: Record<string, unknown> }[]>(BEFORE_COPY_SQL, organizationId)).map(r => r.row)
  return { kind: BEFORE_COPY_KIND, version: 1, createdAt: now.toISOString(), organizationId, columns: COPIED_COLUMNS.map(([c]) => c), rows }
}

// A refusal of the restore's own: its message names no data.
export class RestoreRefused extends Error {}

// Checks a before-copy file before anything is restored: its kind, its organization, and
// only known column names (they go into SQL as identifiers).
export function parseBeforeCopy(raw: unknown, organizationId: string): BeforeCopy {
  const c = raw as Partial<BeforeCopy> | null
  if (!c || c.kind !== BEFORE_COPY_KIND || c.version !== 1 || !Array.isArray(c.rows) || !Array.isArray(c.columns)) {
    throw new RestoreRefused('that file is not a CRM-wins before-copy; nothing changed')
  }
  if (c.organizationId !== organizationId) throw new RestoreRefused('that before-copy is for another organization; nothing changed')
  if (c.columns.length === 0 || !c.columns.every(col => TYPES.has(col))) throw new RestoreRefused('that before-copy names columns this code doesn\'t copy; nothing changed')
  if (!c.rows.every(r => r && typeof r.id === 'string')) throw new RestoreRefused('that before-copy has a row without an id; nothing changed')
  return c as BeforeCopy
}

// The value a column is put back to: the saved one; metadata keeps a do-not-contact mark.
const restoredExpr = (c: string) =>
  c === 'metadata'
    ? `CASE WHEN m.metadata->>'crmOptOut' = 'true' THEN COALESCE(r.metadata, '{}'::jsonb) || '{"crmOptOut": true}'::jsonb ELSE r.metadata END`
    : `r.${q(c)}`
const recordset = (columns: string[]) =>
  `jsonb_to_recordset($1::jsonb) AS r(id text, ${columns.map(c => `${q(c)} ${TYPES.get(c)}`).join(', ')})`
const differs = (columns: string[]) =>
  `(${columns.map(restoredExpr).join(', ')}) IS DISTINCT FROM (${columns.map(c => `m.${q(c)}`).join(', ')})`

// $1 = the rows (jsonb), $2 = organizationId. Read only: rows found, and how many differ now.
export const restoreCheckSql = (columns: string[]) => `
SELECT count(*)::int AS found, count(*) FILTER (WHERE ${differs(columns)})::int AS differ
FROM ${recordset(columns)}
JOIN "MojoContact" m ON m.id = r.id AND m."organizationId" = $2 AND NOT m."isTestData"`

// $1 = the rows (jsonb), $2 = organizationId. Puts the columns back on rows that differ.
export const restoreSql = (columns: string[]) => `
UPDATE "MojoContact" AS m SET "updatedAt" = now(), ${columns.map(c => `${q(c)} = ${restoredExpr(c)}`).join(', ')}
FROM ${recordset(columns)}
WHERE m.id = r.id AND m."organizationId" = $2 AND NOT m."isTestData" AND ${differs(columns)}`

export interface RestoreCounts { rowsInFile: number; found: number; missing: number; differ: number }

export async function restoreCheck(db: Pick<PrismaClient, '$queryRawUnsafe'>, copy: BeforeCopy): Promise<RestoreCounts> {
  const [r] = await db.$queryRawUnsafe<{ found: number; differ: number }[]>(restoreCheckSql(copy.columns), JSON.stringify(copy.rows), copy.organizationId)
  return { rowsInFile: copy.rows.length, found: r.found, missing: copy.rows.length - r.found, differ: r.differ }
}

// One transaction: the switch goes off, the columns go back, one AuditLog row (counts
// only). Then a read-only check of what still differs (only rows with a do-not-contact
// mark added since can).
export async function applyRestore(db: PrismaClient, copy: BeforeCopy): Promise<RestoreCounts & { restored: number; stillDiffer: number }> {
  const before = await restoreCheck(db, copy)
  const restored = await db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.featureFlag.upsert({ where: { id: CRM_WINS }, update: { enabled: false }, create: { id: CRM_WINS, enabled: false } })
    const n = await tx.$executeRawUnsafe(restoreSql(copy.columns), JSON.stringify(copy.rows), copy.organizationId)
    await tx.auditLog.create({
      data: { organizationId: copy.organizationId, action: RESTORE_ACTION, detailsJson: { beforeCopyAt: copy.createdAt, rowsInFile: before.rowsInFile, missing: before.missing, restored: n } },
    })
    return n
  }, { maxWait: 10_000, timeout: 120_000 })
  const after = await restoreCheck(db, copy)
  return { ...before, restored, stillDiffer: after.differ }
}

// ── scripts/brief48-crm-wins-switch.ts ──────────────────────────────────────

// Where the before-copy goes unless --preimage-dir says otherwise (CONTRACT: the brief's
// private folder, owner-only).
export const defaultBeforeCopyDir = (home: string) => join(home, 'dev', 'brief48-dealflow-fixes', 'private')

export type SwitchCommand = { kind: 'state' } | { kind: 'on'; dir: string | null } | { kind: 'off' } | { kind: 'restore'; file: string }

// The script's own arguments (dbGuard's scriptArgs: without --apply, --dry-run, --i-mean-live).
export function parseSwitchCommand(args: readonly string[]): SwitchCommand | 'usage' {
  if (args[0] === '--restore') return args.length === 2 && !args[1].startsWith('--') ? { kind: 'restore', file: args[1] } : 'usage'
  const at = args.indexOf(PREIMAGE_DIR_FLAG)
  const dir = at >= 0 ? args[at + 1] : null
  if (at >= 0 && (!dir || dir.startsWith('--'))) return 'usage'
  const wanted = parseCrmWinsArgs(at >= 0 ? args.filter((_, i) => i !== at && i !== at + 1) : args)
  if (wanted === 'usage' || (dir && wanted !== 'on')) return 'usage'
  return wanted === null ? { kind: 'state' } : wanted === 'on' ? { kind: 'on', dir } : { kind: 'off' }
}

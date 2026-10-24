import { randomUUID } from 'crypto'
import type { PrismaClient } from '@prisma/client'
import type { CrmLeadRow } from './crmReader'
import type { SyncPlan } from './plan'
import { COLUMNS, toUpsertRow, unionExpr, type UpsertReturn } from './upsert'
import { phoneKey } from './mapLead'
import { normalizeStreet } from './addressNormalize'
import { isOptOutWording } from '../chat/sellerCard'

// Brief 48 (PR 7, item 1.5): "CRM wins" for the CRM → DealFlow lead copy
// [Ryan, 2026-10-19: yes, behind a switch with a preview]. Ryan works leads in
// the CRM now, and under the copy's keep-old rule (upsert.ts) the CRM could only
// fill DealFlow's blanks, so his edits never arrived (the call list kept an old
// "last called" date, for one).
//
// The switch is the FeatureFlag row CRM_WINS, read once per copy, the same way
// USE_OUR_ESTIMATES is read (lib/matching/ourEstimates.ts). Off: no row, enabled
// false, anything else, or a read that fails [engineering precaution: the copy
// as before is the safe side]. Off, the copy is exactly what it was.
//
// On, for a seller DealFlow already has [Ryan, 2026-10-19]:
//   - a CRM value that isn't blank replaces DealFlow's; a blank in the CRM
//     never erases DealFlow's value;
//   - the phone and email lists become the CRM's lists when the CRM has any;
//   - neighborhood is still written only when the seller is first copied, and
//     metadata is still merged (old || new), so marks like crmOptOut stay.
// Five refinements [engineering precaution]:
//   - the name: only the CRM lead's own name replaces DealFlow's. When the CRM
//     lead has none, the copy names the seller from the CRM's display name or
//     the Mojo ID, which isn't a name to overwrite a real one with;
//   - notes: nothing in DealFlow writes MojoContact.notes today except this
//     copy, but DealFlow's old Mojo importers did (the CSV upload and the
//     Zapier webhook, removed in Brief 34 PR B), so a seller may hold notes the
//     CRM doesn't have. When the CRM's notes differ (and neither contains the
//     other), they replace DealFlow's and DealFlow's earlier text is kept
//     underneath, after the line NOTES_KEPT_HEADING, never thrown away [Ryan,
//     2026-10-19: keep anything DealFlow wrote itself]. Later runs replace only
//     the part above the line (crmWinsNotes);
//   - a do-not-call status (the words the call list's hard filter excludes,
//     lib/ranking/hardFilters.ts, or the opt-out wording Drift's "do not
//     contact" badge reads, lib/chat/sellerCard.ts isOptOutWording) is never
//     replaced by one that isn't;
//   - a 0 from the CRM in a number field (square feet, year built, units) is
//     Mojo's "unknown", like 0 beds and baths (mapLead nonZero), so it never
//     replaces DealFlow's number;
//   - a seller with per-phone do-not-call flags or phone types stored
//     (phoneDncFlags, phoneTypes: lined up with the phone list by position)
//     keeps its phone list, so a flag can't end up on the wrong number.
// A new seller is written exactly as before, whichever way the switch is set.

export const CRM_WINS = 'CRM_WINS'

// Only an error's class reaches the log: its message could quote a query.
const className = (e: unknown) => (e instanceof Error ? e.constructor.name : 'unknown')

export function crmWinsIsOn(row: unknown): boolean {
  return typeof row === 'object' && row !== null && (row as { enabled?: unknown }).enabled === true
}

// The switch's state, or null when it couldn't be read (the copy then runs keep-old).
export async function readCrmWinsSwitchState(db: Pick<PrismaClient, 'featureFlag'>): Promise<boolean | null> {
  try {
    return crmWinsIsOn(await db.featureFlag.findUnique({ where: { id: CRM_WINS }, select: { enabled: true } }))
  } catch (e) {
    console.warn(`[crm-sync] the ${CRM_WINS} switch couldn't be read (${className(e)}): copying with the keep-old rule`)
    return null
  }
}

export async function readCrmWinsSwitch(db: Pick<PrismaClient, 'featureFlag'>): Promise<boolean> {
  return (await readCrmWinsSwitchState(db)) ?? false
}

// Brief 48 (PR 7 review r2, nit 5; executor, 2026-10-23) [engineering precaution]: the copy
// reads the switch again as the first statement of its transaction, locked FOR SHARE. A
// restore or the switch script that changes the switch while a copy runs then waits for the
// copy to finish (they update this row), and a copy that finds the switch changed since it
// planned (a restore committed in between) rolls back instead of writing over the restore.
export const SWITCH_IN_TRANSACTION_SQL = `SELECT enabled FROM "FeatureFlag" WHERE id = '${CRM_WINS}' FOR SHARE`

export class CrmWinsSwitchChanged extends Error {
  constructor() {
    super(`the ${CRM_WINS} switch changed while the copy was being planned; rolled back, nothing written (the next copy runs as usual)`)
    this.name = 'CrmWinsSwitchChanged'
  }
}

// ── scripts/brief48-crm-wins-switch.ts ──────────────────────────────────────

export const CRM_WINS_USAGE =
  'usage: npx tsx scripts/brief48-crm-wins-switch.ts [--on [--preimage-dir <dir>] | --off | --restore <before-copy file>] [--apply [--i-mean-live]]'

// The script's own arguments (dbGuard's scriptArgs: without --apply, --dry-run, --i-mean-live).
export function parseCrmWinsArgs(args: readonly string[]): 'on' | 'off' | null | 'usage' {
  if (args.length === 0) return null
  if (args.length === 1 && args[0] === '--on') return 'on'
  if (args.length === 1 && args[0] === '--off') return 'off'
  return 'usage'
}

export const describeCrmWins = (row: { enabled: boolean } | null) => (row == null ? 'off (no row)' : crmWinsIsOn(row) ? 'on' : 'off')

// The switch's state; with --on or --off and --apply, the change. Output: the state only.
export async function runCrmWinsSwitch(
  db: Pick<PrismaClient, 'featureFlag'>,
  wanted: 'on' | 'off' | null,
  apply: boolean,
): Promise<string[]> {
  const row = await db.featureFlag.findUnique({ where: { id: CRM_WINS }, select: { enabled: true } })
  const state = `${CRM_WINS}: ${describeCrmWins(row)}`
  if (wanted == null) return [state]
  const enabled = wanted === 'on'
  if (enabled === crmWinsIsOn(row)) return [`${state}, unchanged`]
  if (!apply) return [state, `Dry run: nothing changed. Add --apply to turn it ${wanted}.`]
  await db.featureFlag.upsert({ where: { id: CRM_WINS }, update: { enabled }, create: { id: CRM_WINS, enabled } })
  return [`${state} -> ${wanted}. The next CRM copy (the nightly run at 09:00 UTC, or scripts/crm-lead-sync.ts) uses it.`]
}

// ── The rules ───────────────────────────────────────────────────────────────

export const NOTES_KEPT_HEADING = 'Earlier notes kept by DealFlow:'

// The status words the call list's hard filter treats as do not call
// (lib/ranking/hardFilters.ts STATUS_DNC; crmWins.unit.test.ts checks each one
// is excluded there).
export const DO_NOT_CALL_STATUS = ['do_not_call', 'do not call', 'dnc', 'opt-out', 'opted out'] as const
export const isDoNotCallStatus = (s: unknown): boolean =>
  typeof s === 'string' && DO_NOT_CALL_STATUS.some(w => s.toLowerCase().includes(w))

// Brief 48 (PR 7 review r1) [engineering precaution]: Drift's "do not contact"
// badge (lib/chat/crmSellers.ts doNotContact) also reads opt-out wording in
// status ("Remove me from your list", "Stop calling", "Do-Not-Call"), which the
// words above miss. Under keep-old, status stayed the first call result the copy
// saw, so the badge stayed; with CRM wins it becomes the latest one. So a status
// with either kind of wording is kept unless the CRM's is one too. The wording
// check is JavaScript, so runSync reads the current statuses (STATUS_SQL) and
// sends the decision with each row (keepStatus).
export const isOptOutStatus = (s: unknown): boolean => isDoNotCallStatus(s) || (typeof s === 'string' && isOptOutWording(s))
// Brief 48 (PR 7 review r2) [engineering precaution]: each reader on its own. The call
// list's words are a substring match, so "Non-DNC" and "DNC scrub passed" count, while
// Drift's wording leaves those out on purpose; so a CRM status one reader calls an opt-out
// could still drop the other's mark (DealFlow's "DNC" replaced by the CRM's "Non-DNC"
// lost Drift's badge). DealFlow's status is kept when the CRM's would lose a mark either
// reader sees in it today.
const optOutWording = (s: unknown): boolean => typeof s === 'string' && isOptOutWording(s)
export const crmWinsKeepStatus = (current: unknown, crm: unknown): boolean =>
  (isDoNotCallStatus(current) && !isDoNotCallStatus(crm)) || (optOutWording(current) && !optOutWording(crm))

// $1 = organizationId. Every real seller's current status (read only with the switch on).
export const STATUS_SQL = `
SELECT id, status FROM "MojoContact" WHERE "organizationId" = $1 AND NOT "isTestData" AND status IS NOT NULL`

// The CRM lead's own name (the field Ryan edits: the CRM's lead page writes
// name and displayName together), or null when it has none.
export const crmOwnName = (lead: Pick<CrmLeadRow, 'name'>): string | null => (lead.name ?? '').replace(/\s+/g, ' ').trim() || null

// The notes rule above, in order:
//   1 a blank (null) on either side keeps the other side;
//   2 the CRM's notes contain all of DealFlow's (the CRM added to them): the CRM's;
//   3 DealFlow's notes contain all of the CRM's: DealFlow's, which lose nothing;
//   4 DealFlow's notes already have the heading: the CRM's notes, then DealFlow's
//     part from the heading on, unchanged;
//   5 otherwise the CRM's notes, the heading, and DealFlow's earlier text.
export function crmWinsNotes(old: string | null, crm: string | null): string | null {
  if (crm == null || old == null || crm.includes(old)) return crm ?? old
  if (old.includes(crm)) return old
  const at = old.indexOf(NOTES_KEPT_HEADING)
  return at >= 0 ? `${crm}\n\n${old.slice(at)}` : `${crm}\n\n${NOTES_KEPT_HEADING}\n${old}`
}

// The row the CRM-wins statements take: the CRM's values as they are (the phone
// and email lists unmerged), plus the lead's own name.
export function toCrmWinsRow({ contact, keeper }: SyncPlan['upserts'][number], ownName: string | null, keepStatus = false) {
  const { phones, emails, ...fields } = contact
  return {
    ...fields, id: keeper?.id ?? randomUUID(), crmOwnName: ownName, keepStatus,
    phone: phones[0] ?? null, additionalPhones: phones.slice(1), email: emails[0] ?? null, additionalEmails: emails.slice(1),
  }
}
export type CrmWinsRow = ReturnType<typeof toCrmWinsRow>

// ── SQL ($1 = jsonb array of rows, $2 = organizationId; RETURNING old/new needs Postgres 18) ──

const q = (c: string) => `"${c}"`
const UPDATED = COLUMNS.filter(([, , mode]) => mode !== 'insert')
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`
const dncSql = (v: string) => `EXISTS (SELECT 1 FROM unnest(ARRAY[${DO_NOT_CALL_STATUS.map(lit).join(', ')}]) AS w WHERE strpos(lower(COALESCE(${v}, '')), w) > 0)`
// The property facts where a CRM 0 is Mojo's "unknown" (see above). Named, not every
// number column: elsewhere a 0 can be a fact (a loan balance of 0 is free and clear).
const NUMERIC = new Set(['unitCount', 'propertyBeds', 'propertyBaths', 'buildingSqft', 'yearBuilt'])
const PHONES_REPLACE = `s."phone" IS NOT NULL AND cardinality(COALESCE(m."phoneDncFlags", '{}')) = 0 AND cardinality(COALESCE(m."phoneTypes", '{}')) = 0`
const H = lit(NOTES_KEPT_HEADING)
const NOTES_SQL = `CASE WHEN s."notes" IS NULL OR m."notes" IS NULL OR strpos(s."notes", m."notes") > 0 THEN COALESCE(s."notes", m."notes")
    WHEN strpos(m."notes", s."notes") > 0 THEN m."notes"
    WHEN strpos(m."notes", ${H}) > 0 THEN s."notes" || E'\\n\\n' || substr(m."notes", strpos(m."notes", ${H}))
    ELSE s."notes" || E'\\n\\n' || ${H} || E'\\n' || m."notes" END`

export function crmWinsExpr(c: string): string {
  switch (c) {
    case 'fullName': return `COALESCE(s."crmOwnName", m."fullName")`
    case 'phone': case 'additionalPhones': return `CASE WHEN ${PHONES_REPLACE} THEN s.${q(c)} ELSE m.${q(c)} END`
    case 'email': case 'additionalEmails': return `CASE WHEN s."email" IS NOT NULL THEN s.${q(c)} ELSE m.${q(c)} END`
    case 'status': return `CASE WHEN s."keepStatus" OR (${dncSql('m."status"')} AND NOT ${dncSql('s."status"')}) THEN m."status" ELSE COALESCE(s."status", m."status") END`
    case 'notes': return NOTES_SQL
    case 'metadata': return `COALESCE(m."metadata", '{}'::jsonb) || s."metadata"`
    case 'tags': return unionExpr('m."tags"', 's."tags"') // Brief 48 (PR 9): only ever added to, either way
    default: return NUMERIC.has(c) ? `COALESCE(NULLIF(s.${q(c)}, 0), m.${q(c)})` : `COALESCE(s.${q(c)}, m.${q(c)})`
  }
}

const SRC = `WITH src AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(id text, "mojoId" text, "crmOwnName" text, "keepStatus" boolean, ${COLUMNS.map(([c, t]) => `${q(c)} ${t}`).join(', ')})
)`
const snapshot = (alias: string) => `jsonb_build_object(${UPDATED.map(([c]) => `'${c}', ${alias}.${q(c)}`).join(', ')})`

// Sellers DealFlow already has (same Mojo ID, same organization, never test
// data). Rows whose values would all stay the same aren't touched.
export const CRM_WINS_UPDATE_SQL = `${SRC}
UPDATE "MojoContact" AS m SET "updatedAt" = now(), ${UPDATED.map(([c]) => `${q(c)} = ${crmWinsExpr(c)}`).join(', ')}
FROM src AS s
WHERE m."mojoId" = s."mojoId" AND NOT m."isTestData" AND m."organizationId" = $2
  AND (${UPDATED.map(([c]) => crmWinsExpr(c)).join(', ')}) IS DISTINCT FROM (${UPDATED.map(([c]) => `m.${q(c)}`).join(', ')})
RETURNING m."mojoId", false AS inserted, ${snapshot('old')} AS before, ${snapshot('new')} AS after`

// New sellers, written as UPSERT_SQL writes them. A Mojo ID that's taken (the
// row above, test data, another organization) is left alone, as UPSERT_SQL's
// WHERE leaves it.
export const CRM_WINS_INSERT_SQL = `${SRC}
INSERT INTO "MojoContact" AS m (id, "mojoId", "organizationId", intent, "isTestData", "updatedAt", ${COLUMNS.map(([c]) => q(c)).join(', ')})
SELECT id, "mojoId", $2, 'SELLER', false, now(), ${COLUMNS.map(([c]) => q(c)).join(', ')} FROM src
ON CONFLICT ("mojoId") DO NOTHING
RETURNING m."mojoId", true AS inserted, ${snapshot('old')} AS before, ${snapshot('new')} AS after`

// ── The same rules in memory (the preview; crmWins.integration.test.ts checks
// they give what the SQL gives) ─────────────────────────────────────────────

export type Snapshot = Record<string, unknown>
const TYPES = new Map(COLUMNS.map(([c, t]) => [c, t]))

// A value as jsonb_build_object returns it after the jsonb_to_recordset cast:
// timestamps as "YYYY-MM-DDTHH:MM:SS[.fff]", numbers as numbers.
export function asStored(c: string, v: unknown): unknown {
  if (v == null) return null
  if (TYPES.get(c) === 'timestamp' && typeof v === 'string') return v.replace(' ', 'T')
  if (v instanceof Date) return v.toISOString().replace(/\.000Z$|Z$/, '')
  return v
}

const blank = (v: unknown) => v == null || (Array.isArray(v) && v.length === 0)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
// unionExpr in memory.
const union = (old: unknown, next: unknown) =>
  next == null ? old : [...((old as string[] | null) ?? []), ...(next as string[]).filter(x => !((old as string[] | null) ?? []).includes(x))]

// What CRM_WINS_UPDATE_SQL writes over `before` (an existing seller's row, as
// its snapshot), given the CRM row and whether the seller has per-phone flags
// or types stored.
export function crmWinsAfter(before: Snapshot, row: CrmWinsRow, flagged: boolean): Snapshot {
  const r = row as unknown as Record<string, unknown>
  const s = (c: string) => asStored(c, r[c])
  const after: Snapshot = {}
  const phones = s('phone') != null && !flagged
  for (const [c] of UPDATED) {
    const m = before[c] ?? null
    switch (c) {
      case 'fullName': after[c] = row.crmOwnName ?? m; break
      case 'phone': case 'additionalPhones': after[c] = phones ? s(c) : m; break
      case 'email': case 'additionalEmails': after[c] = s('email') != null ? s(c) : m; break
      case 'status': after[c] = row.keepStatus || (isDoNotCallStatus(m) && !isDoNotCallStatus(s(c))) ? m : s(c) ?? m; break
      case 'notes': after[c] = crmWinsNotes(m as string | null, s(c) as string | null); break
      case 'metadata': after[c] = { ...((m as object | null) ?? {}), ...((s(c) as object | null) ?? {}) }; break
      case 'tags': after[c] = union(m, s(c)); break
      default: after[c] = (NUMERIC.has(c) && s(c) === 0 ? null : s(c)) ?? m
    }
  }
  return after
}

// What UPSERT_SQL (the keep-old rule) writes over `before`, given toUpsertRow's row.
export function keepOldAfter(before: Snapshot, row: Record<string, unknown>): Snapshot {
  const after: Snapshot = {}
  for (const [c, , mode] of UPDATED) {
    const m = before[c] ?? null
    const s = asStored(c, row[c])
    if (mode === 'append') {
      const old = (m as string[] | null) ?? []
      after[c] = same(old, ((s as string[] | null) ?? []).slice(0, old.length)) ? s : m
    } else if (mode === 'merge') after[c] = { ...((m as object | null) ?? {}), ...((s as object | null) ?? {}) }
    else if (mode === 'union') after[c] = union(m, s)
    else after[c] = m ?? s
  }
  return after
}

export interface FieldCounts { filled: Record<string, number>; changed: Record<string, number> }

// The second-and-later slots of a phone or email list: they empty out when the
// CRM's list has one number or address, which is the CRM's list, not an erase.
const LIST_REST = new Set(['additionalPhones', 'additionalEmails'])

// Per column: blanks filled, and values replaced by a different one. Metadata
// isn't counted (it's merged; diffUpdates leaves it out too). `erased` lists
// every value that went blank: the rule says that never happens, so the copy
// rolls back if it isn't empty.
export function countFieldChanges(pairs: Array<{ mojoId: string; before: Snapshot; after: Snapshot }>): FieldCounts & { erased: string[] } {
  const filled: Record<string, number> = {}
  const changed: Record<string, number> = {}
  const erased: string[] = []
  for (const { mojoId, before, after } of pairs) {
    for (const [c] of UPDATED) {
      if (c === 'metadata') continue
      const b = before[c] ?? null, a = after[c] ?? null
      if (same(b, a)) continue
      if (blank(b)) { if (!blank(a)) filled[c] = (filled[c] ?? 0) + 1 }
      else if (blank(a) && !LIST_REST.has(c)) erased.push(`${mojoId}.${c}`)
      else changed[c] = (changed[c] ?? 0) + 1
    }
  }
  return { filled, changed, erased }
}

// The CRM_LEAD_SYNC audit counts for a run with the switch on, from the rows
// the statements returned. Counts only.
export function crmWinsRunCounts(returned: UpsertReturn[]) {
  const updated = returned.filter(r => !r.inserted)
  const { filled, changed, erased } = countFieldChanges(updated)
  const had = (s: Snapshot) => typeof s.notes === 'string' && s.notes.includes(NOTES_KEPT_HEADING)
  return { filled, changed, erased, notesKeptBelow: updated.filter(r => had(r.after) && !had(r.before)).length }
}

// Brief 48 (PR 7 review r1) [engineering precaution]: the mass-change limit. Under
// keep-old any change rolled the copy back. With CRM wins changes are the point, but
// a broken CRM read (a bad join, a renamed field) could still rewrite every seller in
// one morning, and a value the CRM normally leaves blank would then stay wrong (a
// blank never erases). So a run that drops DealFlow's phone numbers or emails, or
// replaces names or streets, for more than massChangeLimit() sellers rolls back,
// except on the first copy after the switch is turned on (the preview is that run's
// check). To let a known bulk change through, turn the switch off and on again with
// scripts/brief48-crm-wins-switch.ts (CRM_WINS_RAN_LAST_SQL).
export const MASS_CHANGE_MIN = 50
export const MASS_CHANGE_SHARE = 0.1
export const massChangeLimit = (existingSellers: number): number =>
  Math.max(MASS_CHANGE_MIN, Math.ceil(MASS_CHANGE_SHARE * existingSellers))

export interface IdentityLosses { phonesDropped: number; emailsDropped: number; namesReplaced: number; streetsReplaced: number }
const keysOf = (s: Snapshot, first: string, rest: string, key: (v: string) => string | null) =>
  new Set([s[first], ...((s[rest] as unknown[] | null) ?? [])].filter((v): v is string => typeof v === 'string').map(key).filter(Boolean))
const nameKey = (v: unknown) => (typeof v === 'string' ? v.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') || null : null)

// Per seller (counts only): a phone number (by its 10 digits) or an email DealFlow had
// is gone; a name or a street (normalized) was replaced by a different one.
export function identityLosses(pairs: Array<{ before: Snapshot; after: Snapshot }>): IdentityLosses {
  const out: IdentityLosses = { phonesDropped: 0, emailsDropped: 0, namesReplaced: 0, streetsReplaced: 0 }
  const dropped = (b: Snapshot, a: Snapshot, first: string, rest: string, key: (v: string) => string | null) => {
    const kept = keysOf(a, first, rest, key)
    return [...keysOf(b, first, rest, key)].some(k => !kept.has(k))
  }
  for (const { before, after } of pairs) {
    if (dropped(before, after, 'phone', 'additionalPhones', phoneKey)) out.phonesDropped++
    if (dropped(before, after, 'email', 'additionalEmails', e => e.trim().toLowerCase() || null)) out.emailsDropped++
    const n0 = nameKey(before.fullName), n1 = nameKey(after.fullName)
    if (n0 && n1 && n0 !== n1) out.namesReplaced++
    const s0 = normalizeStreet(before.address as string | null), s1 = normalizeStreet(after.address as string | null)
    if (s0 && s1 && s0 !== s1) out.streetsReplaced++
  }
  return out
}

export const overMassChangeLimit = (losses: IdentityLosses, limit: number): string[] =>
  Object.entries(losses).filter(([, n]) => n > limit).map(([k, n]) => `${k} ${n}`)

// $1 = organizationId. Whether a copy with the switch on has been applied since the switch
// was last set (FeatureFlag.updatedAt): false on the first copy after it is turned on.
// Brief 48 (PR 7 review r2) [engineering precaution]: keyed on the switch, not on the newest
// copy. Keyed on the newest copy, a morning the switch couldn't be read (that copy runs
// keep-old and writes its audit row) gave the next morning a free pass, and turning the
// switch off and on again did nothing unless a copy ran in between. Both times are written
// by Prisma in UTC (the switch script, the restore, runSync's audit row); set the switch
// only through scripts/brief48-crm-wins-switch.ts.
export const CRM_WINS_RAN_LAST_SQL = `
SELECT EXISTS (SELECT 1 FROM "AuditLog" a JOIN "FeatureFlag" f ON f.id = 'CRM_WINS'
  WHERE a."organizationId" = $1 AND a.action = 'CRM_LEAD_SYNC' AND a."detailsJson"->>'crmWins' = 'true' AND a."createdAt" >= f."updatedAt") AS "ranLast"`

// ── scripts/brief48-crm-wins-preview.ts ─────────────────────────────────────

// One existing seller as the preview reads it: its row as the statements'
// snapshot (jsonb_build_object, CURRENT_SQL), and whether it has per-phone
// flags or types stored.
export interface CurrentRow { before: Snapshot; flagged: boolean }

// $1 = organizationId. Every real seller's current values, in the snapshot shape.
export const CURRENT_SQL = `
SELECT m.id, ${snapshot('m')} AS before,
  cardinality(COALESCE(m."phoneDncFlags", '{}')) > 0 OR cardinality(COALESCE(m."phoneTypes", '{}')) > 0 AS flagged
FROM "MojoContact" m WHERE m."organizationId" = $1 AND NOT m."isTestData"`

// $1 = organizationId. Mojo IDs held by a row the copy never writes (test data,
// another organization): a CRM lead with one of them is neither updated nor
// inserted. Ids only.
export const TAKEN_SQL = `
SELECT "mojoId" FROM "MojoContact" WHERE "organizationId" <> $1 OR "isTestData"`

const changedAny = ({ before, after }: { before: Snapshot; after: Snapshot }) =>
  UPDATED.some(([c]) => c !== 'metadata' && !same(before[c] ?? null, after[c] ?? null))

// What the next copy would do to the sellers DealFlow already has, with the
// switch on and (for comparison) with the keep-old rule it uses today. Pure;
// counts only: no seller, name, number, address or value.
export function crmWinsPreview(
  plan: SyncPlan, current: Map<string, CurrentRow>, ownNames: Map<string, string | null>, taken: ReadonlySet<string> = new Set(),
) {
  const wins: Array<{ mojoId: string; before: Snapshot; after: Snapshot }> = []
  const today: typeof wins = []
  let newSellers = 0, heldElsewhere = 0, notesKeptBelow = 0, doNotCallKept = 0, phoneListsKept = 0
  const had = (s: Snapshot) => typeof s.notes === 'string' && s.notes.includes(NOTES_KEPT_HEADING)
  for (const u of plan.upserts) {
    const cur = u.keeper ? current.get(u.keeper.id) : undefined
    if (!cur) {
      if (taken.has(u.contact.mojoId)) heldElsewhere++
      else newSellers++
      continue
    }
    const row = toCrmWinsRow(u, ownNames.get(u.contact.mojoId) ?? null, crmWinsKeepStatus(cur.before.status, u.contact.status))
    const after = crmWinsAfter(cur.before, row, cur.flagged)
    wins.push({ mojoId: u.contact.mojoId, before: cur.before, after })
    today.push({ mojoId: u.contact.mojoId, before: cur.before, after: keepOldAfter(cur.before, toUpsertRow(u)) })
    if (had(after) && !had(cur.before)) notesKeptBelow++
    if (row.status != null && row.status !== cur.before.status && after.status === cur.before.status) doNotCallKept++
    if (cur.flagged && row.phone != null && !same([row.phone, ...row.additionalPhones], [cur.before.phone, ...((cur.before.additionalPhones as string[] | null) ?? [])])) phoneListsKept++
  }
  const w = countFieldChanges(wins)
  const k = countFieldChanges(today)
  const limit = massChangeLimit(wins.length)
  return {
    sellersCompared: wins.length,
    newSellers, // inserted the same way whichever way the switch is set
    heldElsewhere, // Mojo ID held by test data or another organization: left alone either way
    skipped: plan.skipped.length,
    withCrmWins: {
      sellersChanged: wins.filter(changedAny).length,
      changed: w.changed,
      filled: w.filled,
      wentBlank: w.erased.length, // must be 0: the copy would roll back
      notesKeptBelow,
      doNotCallKept,
      phoneListsKept,
      // A later copy (not the first after the switch is turned on) rolls back over the limit.
      identityLosses: identityLosses(wins),
      massChangeLimit: limit,
    },
    keepOldToday: {
      sellersChanged: today.filter(changedAny).length,
      filled: k.filled,
      changed: k.changed, // must be empty: the copy would roll back
    },
  }
}

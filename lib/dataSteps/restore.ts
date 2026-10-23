// Brief 48 (data steps): --restore <before-copy> for all three data steps, and
// the generic part of the read-only after-check. Engineering precaution.
//
// A restore puts back what one run did, in one transaction:
//   1. every removed row is inserted again, whole (parents first);
//   2. every changed row gets its old values back, if it still has the run's values;
//   3. every row the run created is deleted, if it is still as created.
// It refuses (writing nothing) when a row moved on since the run: a removed id
// is back already, a unique key is taken, a changed row has other values now,
// or a created row is gone or changed. It skips, with a count, call-list rows
// once the nightly has rebuilt the list (restoring rows of an old list would
// only leave stale rows).
import type { BeforeCopy, Row } from './common'
import { sum } from './common'
import {
  CHANGE_COLUMNS, applyChanges, assertTable, callListGenerations, deleteRows, fetchRows, insertRows, json,
  type Change, type Table, type Tx,
} from './rows'

// Parents before children (foreign keys), so inserts never point at a missing row.
export const INSERT_ORDER: readonly Table[] = [
  'MojoContact', 'ExtractedOpportunity', 'Match', 'MatchDismissal', 'CallQueueEntry',
  'CallLog', 'InstantlyEvent', 'OutcomeFeedback',
]

// Unique keys an inserted row could collide with (besides its id).
export const UNIQUE_KEYS: Partial<Record<Table, string[]>> = {
  MojoContact: ['mojoId'],
  Match: ['opportunityId', 'counterpartId', 'counterpartType'],
  MatchDismissal: ['partyId', 'listingId'],
}

// A created row is deleted only while it is still what the run created.
export const CREATED_KEY_FIELDS: Partial<Record<Table, string[]>> = {
  ExtractedOpportunity: ['organizationId', 'category', 'isTestData', 'extractedTitle', 'rawEmailId'],
}
export const CREATED_DELETE_GUARD: Partial<Record<Table, string>> = {
  ExtractedOpportunity: `t."isTestData" AND t.category = 'BUYER_ISO'`,
}

// Columns compared apart: a vector's text form may not round-trip digit for digit.
export const LOOSE_COLUMNS = new Set(['embedding'])

export interface RestoreFacts {
  current: Record<string, Row[]> // table → the rows that exist now, for every id in the copy
  generationsNow: string[] // the org's call-list generation ids now
  uniqueTaken: Record<string, string[]> // table → ids of copy rows whose unique key another row holds now
  reportsOnCreated: number // Report rows whose subject is a created row (deleting it would change them)
}

export interface RestorePlan {
  insert: { table: Table; rows: Row[] }[]
  revert: { table: Table; changes: Change[] }[]
  remove: { table: Table; ids: string[] }[]
  skipped: Record<string, number>
  refusals: Record<string, string[]> // reason → ids
  writes: number
  counts: Record<string, { insert: number; revert: number; delete: number }>
}

const norm = (v: unknown) => JSON.stringify(v ?? null)
const sameValues = (row: Record<string, unknown>, want: Record<string, unknown>, cols: string[]) =>
  cols.every(c => norm(row[c]) === norm(want[c]))

export function changeCols(table: Table): string[] {
  const cols = CHANGE_COLUMNS[table]
  return cols ? Object.keys(cols) : []
}

// Pure: what a restore of `copy` would do, given what the database holds now.
export function planRestore(copy: BeforeCopy, facts: RestoreFacts): RestorePlan {
  const plan: RestorePlan = { insert: [], revert: [], remove: [], skipped: {}, refusals: {}, writes: 0, counts: {} }
  const refuse = (reason: string, id: string) => { (plan.refusals[reason] ??= []).push(id) }
  const skip = (reason: string, n = 1) => { plan.skipped[reason] = (plan.skipped[reason] ?? 0) + n }
  const tally = (t: Table) => (plan.counts[t] ??= { insert: 0, revert: 0, delete: 0 })
  const listRebuilt = norm([...facts.generationsNow].sort()) !== norm([...copy.callListGenerations].sort())
  const now = (t: string) => new Map((facts.current[t] ?? []).map(r => [r.id, r]))

  for (const table of INSERT_ORDER) {
    const rows = copy.removed[table] ?? []
    if (rows.length === 0) continue
    const present = now(table)
    const taken = new Set(facts.uniqueTaken[table] ?? [])
    const keep: Row[] = []
    for (const r of rows) {
      if (table === 'CallQueueEntry' && listRebuilt) { skip('call-list rows not put back: the nightly rebuilt the list since'); continue }
      if (present.has(r.id)) { refuse(`${table}: a removed row is back already`, r.id); continue }
      if (taken.has(r.id)) { refuse(`${table}: another row holds its unique key now`, r.id); continue }
      keep.push(r)
    }
    if (keep.length) { plan.insert.push({ table, rows: keep }); tally(table).insert += keep.length }
  }

  for (const [t, changed] of Object.entries(copy.changed)) {
    assertTable(t)
    const cols = changeCols(t)
    const present = now(t)
    const changes: Change[] = []
    for (const c of changed) {
      const cur = present.get(c.before.id)
      if (!cur) {
        if (t === 'CallQueueEntry' && listRebuilt) skip('call-list rows not put back: the nightly rebuilt the list since')
        else refuse(`${t}: a changed row is gone`, c.before.id)
        continue
      }
      if (!sameValues(cur, c.after, cols)) { refuse(`${t}: a changed row has other values now`, c.before.id); continue }
      changes.push({ id: c.before.id, from: pick(c.after, cols), to: pick(c.before, cols) })
    }
    if (changes.length) { plan.revert.push({ table: t, changes }); tally(t).revert += changes.length }
  }

  for (const [t, created] of Object.entries(copy.created)) {
    assertTable(t)
    const fields = CREATED_KEY_FIELDS[t] ?? []
    const present = now(t)
    const ids: string[] = []
    for (const r of created) {
      const cur = present.get(r.id)
      if (!cur) { refuse(`${t}: a created row is gone`, r.id); continue }
      if (!sameValues(cur, r, fields)) { refuse(`${t}: a created row was changed since`, r.id); continue }
      ids.push(r.id)
    }
    if (facts.reportsOnCreated > 0) refuse(`Report: ${facts.reportsOnCreated} saved report(s) are about a created row (deleting it would change them)`, '(reports)')
    if (ids.length) { plan.remove.push({ table: t, ids }); tally(t).delete += ids.length }
  }

  plan.writes = sum(plan.insert.map(i => i.rows.length)) + sum(plan.revert.map(r => r.changes.length)) + sum(plan.remove.map(r => r.ids.length))
  return plan
}

function pick(o: Record<string, unknown>, cols: string[]): Record<string, unknown> {
  return Object.fromEntries(cols.map(c => [c, o[c] ?? null]))
}

export function allCopyIds(copy: BeforeCopy): Record<string, string[]> {
  const out: Record<string, Set<string>> = {}
  const add = (t: string, id: string) => (out[t] ??= new Set()).add(id)
  for (const [t, rows] of Object.entries(copy.removed)) for (const r of rows) add(t, r.id)
  for (const [t, rows] of Object.entries(copy.changed)) for (const r of rows) add(t, r.before.id)
  for (const [t, rows] of Object.entries(copy.created)) for (const r of rows) add(t, r.id)
  return Object.fromEntries(Object.entries(out).map(([t, s]) => [t, [...s]]))
}

export async function loadRestoreFacts(tx: Tx, copy: BeforeCopy): Promise<RestoreFacts> {
  const current: Record<string, Row[]> = {}
  for (const [t, ids] of Object.entries(allCopyIds(copy))) {
    assertTable(t)
    current[t] = await fetchRows(tx, t, ids)
  }
  const uniqueTaken: Record<string, string[]> = {}
  for (const [t, rows] of Object.entries(copy.removed)) {
    assertTable(t)
    const keys = UNIQUE_KEYS[t]
    if (!keys || rows.length === 0) continue
    const revertedIds = new Set((copy.changed[t] ?? []).map(c => c.before.id))
    const q = (s: string) => `"${s}"`
    const taken = await tx.$queryRawUnsafe<{ want: string }[]>(
      `SELECT k.id AS want FROM jsonb_to_recordset($1::jsonb) AS k(id text, ${keys.map(k => `${q(k)} text`).join(', ')})
       JOIN "${t}" t ON (${keys.map(k => `t.${q(k)}`).join(', ')}) = (${keys.map(k => `k.${q(k)}`).join(', ')})
       WHERE t.id <> k.id AND NOT (t.id = ANY(SELECT jsonb_array_elements_text($2::jsonb)))`,
      json(rows.map(r => ({ id: r.id, ...Object.fromEntries(keys.map(k => [k, r[k] == null ? null : String(r[k])])) }))),
      json([...revertedIds]))
    uniqueTaken[t] = taken.map(r => r.want)
  }
  const createdOpps = (copy.created.ExtractedOpportunity ?? []).map(r => r.id)
  const reportsOnCreated = createdOpps.length === 0 ? 0 : (await tx.$queryRawUnsafe<{ n: number }[]>(
    'SELECT count(*)::int AS n FROM "Report" WHERE "opportunityId" IN (SELECT jsonb_array_elements_text($1::jsonb))', json(createdOpps)))[0].n
  return { current, generationsNow: await callListGenerations(tx, copy.organizationId), uniqueTaken, reportsOnCreated }
}

// The writes of a restore, inside the caller's transaction.
export async function applyRestore(tx: Tx, plan: RestorePlan): Promise<void> {
  for (const { table, rows } of plan.insert) await insertRows(tx, table, rows)
  for (const { table, changes } of plan.revert) await applyChanges(tx, table, changes)
  for (const { table, ids } of plan.remove) {
    const guard = CREATED_DELETE_GUARD[table]
    await deleteRows(tx, table, ids, guard ?? '')
  }
}

// Read-only: after a restore, every inserted row equals its before-copy row,
// every reverted row has its old values, and every created row is gone.
export async function checkRestored(tx: Tx, plan: RestorePlan): Promise<{ ok: boolean; mismatched: Record<string, number>; looseColumnsDiffer: number }> {
  const mismatched: Record<string, number> = {}
  let looseColumnsDiffer = 0
  const bad = (t: string, n = 1) => { mismatched[t] = (mismatched[t] ?? 0) + n }
  for (const { table, rows } of plan.insert) {
    const now = new Map((await fetchRows(tx, table, rows.map(r => r.id))).map(r => [r.id, r]))
    for (const r of rows) {
      const cur = now.get(r.id)
      if (!cur) { bad(table); continue }
      const cols = new Set([...Object.keys(r), ...Object.keys(cur)])
      let strictOk = true
      for (const c of cols) {
        if (norm(cur[c]) === norm(r[c])) continue
        if (LOOSE_COLUMNS.has(c)) looseColumnsDiffer++
        else strictOk = false
      }
      if (!strictOk) bad(table)
    }
  }
  for (const { table, changes } of plan.revert) {
    const now = new Map((await fetchRows(tx, table, changes.map(c => c.id))).map(r => [r.id, r]))
    for (const c of changes) {
      const cur = now.get(c.id)
      if (!cur || !sameValues(cur, c.to, Object.keys(c.to))) bad(table)
    }
  }
  for (const { table, ids } of plan.remove) {
    const left = (await fetchRows(tx, table, ids)).length
    if (left) bad(table, left)
  }
  return { ok: Object.keys(mismatched).length === 0, mismatched, looseColumnsDiffer }
}

// Read-only, the generic part of the after-check of a run: removed rows are
// gone, changed rows have the run's values, created rows exist as created.
export async function checkApplied(tx: Tx, copy: BeforeCopy): Promise<{ ok: boolean; problems: Record<string, number>; callListRebuiltSince: boolean }> {
  const problems: Record<string, number> = {}
  const bad = (k: string, n = 1) => { problems[k] = (problems[k] ?? 0) + n }
  const generations = await callListGenerations(tx, copy.organizationId)
  const listRebuilt = norm([...generations].sort()) !== norm([...copy.callListGenerations].sort())
  for (const [t, rows] of Object.entries(copy.removed)) {
    assertTable(t)
    const left = (await fetchRows(tx, t, rows.map(r => r.id))).length
    if (left) bad(`${t}: removed rows still there`, left)
  }
  for (const [t, changed] of Object.entries(copy.changed)) {
    assertTable(t)
    const now = new Map((await fetchRows(tx, t, changed.map(c => c.before.id))).map(r => [r.id, r]))
    for (const c of changed) {
      const cur = now.get(c.before.id)
      if (!cur) { if (!(t === 'CallQueueEntry' && listRebuilt)) bad(`${t}: changed rows gone`); continue }
      if (!sameValues(cur, c.after, Object.keys(c.after))) bad(`${t}: changed rows without the run's values`)
    }
  }
  for (const [t, created] of Object.entries(copy.created)) {
    assertTable(t)
    const fields = CREATED_KEY_FIELDS[t] ?? []
    const now = new Map((await fetchRows(tx, t, created.map(r => r.id))).map(r => [r.id, r]))
    for (const r of created) {
      const cur = now.get(r.id)
      if (!cur || !sameValues(cur, r, fields)) bad(`${t}: created rows missing or changed`)
    }
  }
  return { ok: Object.keys(problems).length === 0, problems, callListRebuiltSince: listRebuilt }
}

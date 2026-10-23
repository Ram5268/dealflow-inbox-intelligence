// Brief 48 data step DS-1: remove the duplicate spreadsheet copies [Ryan 1.4,
// 2026-10-19: keep the original record].
//
// The CRM copy (lib/crm-sync/plan.ts) marks every csv_* twin of a CRM lead as
// MojoContact.metadata = { source: 'duplicate', duplicateOf: <kept record's id> }.
// Matching and the call list already leave them out (they only take source
// 'crm'). This step deletes those rows in Ryan's organization, and first moves
// or removes everything that points at them, in the same transaction. The kept
// records themselves are never written (the after-check compares their
// fingerprints).
//
// Per table [engineering precaution, following the brief: history moves to the
// kept record, derived rows can go]:
//   Match, seller side (opportunityType 'contact')     remove: the nightly's own rows; it rebuilds the kept record's
//   Match, buyer side (counterpartType 'mojo')         remove: derived (old matcher or engine rows; DS-3 removes the old matcher's anyway)
//   MatchDismissal (partyId / listingId)               move to the kept record: Ryan's decision about that person;
//                                                      removed only if the kept record already has the same pair
//   CallQueueEntry of a duplicate                      remove: a snapshot the nightly rebuilds (only CRM sellers are on it)
//   CallQueueEntry naming a removed match              drop that match id (primaryMatchId → null, out of contributingMatchIds)
//   CallLog                                            move: call history
//   InstantlyEvent                                     move: email history
//   OutcomeFeedback                                    move opportunityId; a removed match id → null
//   any other table with a foreign key to MojoContact  refuse if a row points at a duplicate. Found in the
//                                                      database's own catalog, so DS-1 never names or reads
//                                                      the table of DealFlow's own value estimates (Brief 44).
//                                                      Those values appear only on Ryan's own CRM lead page
//                                                      [Ryan, 2026-10-17]; the list of files allowed to read
//                                                      them (lib/valuations/__tests__/readers.unit.test.ts,
//                                                      Brief 49) is an [engineering precaution]. Values are
//                                                      made for CRM sellers only, so none is expected; that
//                                                      table's ON DELETE CASCADE would otherwise remove them
//                                                      unseen.
// Counted, never rewritten: AuditLog, chat, reports, Drift's interaction rows,
// the review queue, the Zapier log and mojo_raw (lib/dataSteps/rows.ts MENTION_TARGETS).
//
// Refuses to run when any duplicate's duplicateOf is missing or points at no
// row, at a row in another organization, at itself or at another duplicate
// [Brief 48, executor]; and when it points at a test row, or a duplicate isn't
// a csv_* copy or carries a CRM lead id (a CRM lead could be keyed to it)
// [engineering precaution].
//
// Its write transaction first locks Match, MatchDismissal, OutcomeFeedback and
// CallQueueEntry against writes (none has a foreign key that would stop a new
// row naming a duplicate or a removed match mid-transaction) [Brief 48 review,
// engineering precaution]. Run it outside the nightly (4:45–5:30 am) and the
// 7:00 am CRM copy.
import { DataStepRefusal, emptyBeforeCopy, someIds, sum, type BeforeCopy, type ChangedRow, type Row } from './common'
import {
  applyChanges, auditRow, count, countMentions, deleteRows, fetchRows, inIds, json,
  type Change, type Table, type Tx,
} from './rows'
import type { Step } from './runner'

export const DS1_ACTION = 'BRIEF48_DS1_DUPLICATES_REMOVED'
export const DS1_RESTORE_ACTION = 'BRIEF48_DS1_RESTORED'

export interface Ds1Duplicate {
  id: string
  mojoId: string
  organizationId: string
  isTestData: boolean
  duplicateOf: string | null
  hasCrmLeadId: boolean
}
export interface Ds1Keeper { id: string; organizationId: string; isTestData: boolean; source: string | null; hash: string }

export interface Ds1Facts {
  orgId: string
  duplicates: Ds1Duplicate[] // every source='duplicate' row, any organization
  keepers: Ds1Keeper[] // the rows their duplicateOf names (that exist)
  sellerMatches: { id: string; opportunityId: string }[]
  buyerMatches: { id: string; counterpartId: string }[]
  otherTypeMatches: number // a duplicate's id under another opportunity/counterpart type (left as is)
  dismissals: { id: string; partyId: string; listingId: string; dismissedAt: string }[] // touching a duplicate or a kept record
  queueOfDuplicates: { id: string }[]
  queueNamingRemoved: { id: string; primaryMatchId: string | null; contributingMatchIds: string[] }[]
  callLogs: { id: string; contactId: string }[]
  callLogsOnRemovedQueueRows: number
  instantly: { id: string; contactId: string }[]
  otherForeignKeys: Record<string, number> // "table"."column" → rows pointing at a duplicate (refuse when any)
  feedback: { id: string; opportunityId: string | null; matchId: string | null }[]
  exactMentions: Record<string, number> // Report.buyerId, mojo_raw.mojoId
}

export interface Ds1Plan {
  duplicates: string[] // ids to delete
  keeperOf: Record<string, string>
  refusals: Record<string, string[]> // reason → duplicate ids
  outOfScope: { otherOrganizations: number; testData: number }
  removeMatches: string[]
  removeDismissals: string[] // collisions
  changeDismissals: Change[]
  removeQueue: string[]
  changeQueue: Change[]
  changeCallLogs: Change[]
  changeInstantly: Change[]
  changeFeedback: Change[]
}

export const REFUSAL_REASONS = {
  noDuplicateOf: 'duplicateOf is missing',
  keeperNotFound: 'duplicateOf points at no row',
  keeperOtherOrg: 'duplicateOf points at another organization',
  keeperIsDuplicate: 'duplicateOf points at another duplicate',
  keeperIsTest: 'duplicateOf points at a test row',
  pointsAtItself: 'duplicateOf points at itself',
  notCsvCopy: "the duplicate isn't a csv_* spreadsheet copy",
  carriesCrmLeadId: 'the duplicate carries a CRM lead id',
} as const

const byDateThenId = (a: { dismissedAt: string; id: string }, b: { dismissedAt: string; id: string }) =>
  a.dismissedAt < b.dismissedAt ? -1 : a.dismissedAt > b.dismissedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0

// Pure: the whole DS-1 plan from what the database holds.
export function planDs1(f: Ds1Facts): Ds1Plan {
  const mine = f.duplicates.filter(d => d.organizationId === f.orgId && !d.isTestData)
  const keepers = new Map(f.keepers.map(k => [k.id, k]))
  const refusals: Record<string, string[]> = {}
  const refuse = (key: keyof typeof REFUSAL_REASONS, id: string) => { (refusals[REFUSAL_REASONS[key]] ??= []).push(id) }
  const keeperOf: Record<string, string> = {}
  for (const d of mine) {
    if (!d.mojoId.startsWith('csv_')) refuse('notCsvCopy', d.id)
    if (d.hasCrmLeadId) refuse('carriesCrmLeadId', d.id)
    if (!d.duplicateOf) { refuse('noDuplicateOf', d.id); continue }
    if (d.duplicateOf === d.id) { refuse('pointsAtItself', d.id); continue }
    const k = keepers.get(d.duplicateOf)
    if (!k) { refuse('keeperNotFound', d.id); continue }
    if (k.organizationId !== d.organizationId) refuse('keeperOtherOrg', d.id)
    if (k.source === 'duplicate') refuse('keeperIsDuplicate', d.id)
    if (k.isTestData) refuse('keeperIsTest', d.id)
    keeperOf[d.id] = k.id
  }
  const dupIds = new Set(mine.map(d => d.id))
  const toKeeper = (id: string) => keeperOf[id] ?? id

  const removeMatches = [...new Set([...f.sellerMatches.map(m => m.id), ...f.buyerMatches.map(m => m.id)])].sort()
  const removedMatch = new Set(removeMatches)

  // Dismissals: the earliest one per new pair moves; the kept record's own
  // dismissals stay as they are; the rest would collide, so they go.
  const touching = f.dismissals.filter(d => dupIds.has(d.partyId) || dupIds.has(d.listingId)).sort(byDateThenId)
  const occupied = new Set(f.dismissals.filter(d => !dupIds.has(d.partyId) && !dupIds.has(d.listingId)).map(d => `${d.partyId}|${d.listingId}`))
  const removeDismissals: string[] = []
  const changeDismissals: Change[] = []
  for (const d of touching) {
    const to = { partyId: toKeeper(d.partyId), listingId: toKeeper(d.listingId) }
    const key = `${to.partyId}|${to.listingId}`
    if (to.partyId === to.listingId || occupied.has(key)) { removeDismissals.push(d.id); continue }
    occupied.add(key)
    changeDismissals.push({ id: d.id, from: { partyId: d.partyId, listingId: d.listingId }, to })
  }

  const removeQueue = f.queueOfDuplicates.map(q => q.id).sort()
  const removedQueue = new Set(removeQueue)
  const changeQueue: Change[] = f.queueNamingRemoved.filter(q => !removedQueue.has(q.id)).map(q => ({
    id: q.id,
    from: { primaryMatchId: q.primaryMatchId, contributingMatchIds: q.contributingMatchIds },
    to: {
      primaryMatchId: q.primaryMatchId && removedMatch.has(q.primaryMatchId) ? null : q.primaryMatchId,
      contributingMatchIds: q.contributingMatchIds.filter(id => !removedMatch.has(id)),
    },
  }))
  const move = (rows: { id: string; contactId: string }[]): Change[] =>
    rows.map(r => ({ id: r.id, from: { contactId: r.contactId }, to: { contactId: toKeeper(r.contactId) } }))
  const changeFeedback: Change[] = f.feedback.map(r => ({
    id: r.id,
    from: { opportunityId: r.opportunityId, matchId: r.matchId },
    to: {
      opportunityId: r.opportunityId && dupIds.has(r.opportunityId) ? toKeeper(r.opportunityId) : r.opportunityId,
      matchId: r.matchId && removedMatch.has(r.matchId) ? null : r.matchId,
    },
  }))

  return {
    duplicates: [...dupIds].sort(),
    keeperOf,
    refusals,
    outOfScope: {
      otherOrganizations: f.duplicates.filter(d => d.organizationId !== f.orgId).length,
      testData: f.duplicates.filter(d => d.organizationId === f.orgId && d.isTestData).length,
    },
    removeMatches,
    removeDismissals: removeDismissals.sort(),
    changeDismissals,
    removeQueue,
    changeQueue,
    changeCallLogs: move(f.callLogs),
    changeInstantly: move(f.instantly),
    changeFeedback,
  }
}

export function keptBySource(p: Ds1Plan, f: Ds1Facts): Record<string, number> {
  const used = new Set(Object.values(p.keeperOf))
  const out: Record<string, number> = {}
  for (const k of f.keepers) if (used.has(k.id)) out[k.source ?? '(none)'] = (out[k.source ?? '(none)'] ?? 0) + 1
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
}

export function ds1Writes(p: Ds1Plan): number {
  return p.duplicates.length + p.removeMatches.length + p.removeDismissals.length + p.changeDismissals.length +
    p.removeQueue.length + p.changeQueue.length + p.changeCallLogs.length + p.changeInstantly.length +
    p.changeFeedback.length
}

// Counts and ids only: what the dry run prints, and the AuditLog details.
export function ds1Summary(p: Ds1Plan, f: Ds1Facts, mentions: Record<string, number> | null) {
  const refusalCounts = Object.fromEntries(Object.values(REFUSAL_REASONS).map(r => [r, p.refusals[r]?.length ?? 0]))
  return {
    duplicates: {
      toRemove: p.duplicates.length,
      keptRecords: new Set(Object.values(p.keeperOf)).size,
      // Brief 48 review: what the kept records are, by metadata.source ('crm' expected).
      keptRecordsBySource: keptBySource(p, f),
      leftAlone: p.outOfScope,
    },
    refusals: refusalCounts,
    references: {
      'Match, duplicate as the seller (remove)': f.sellerMatches.length,
      'Match, duplicate as the buyer side (remove)': f.buyerMatches.length,
      'Match naming a duplicate under another type (left as is)': f.otherTypeMatches,
      'MatchDismissal (move to the kept record)': p.changeDismissals.length,
      'MatchDismissal (remove: the kept record already has it)': p.removeDismissals.length,
      'CallQueueEntry of a duplicate (remove)': p.removeQueue.length,
      'CallQueueEntry naming a removed match (drop the match id)': p.changeQueue.length,
      'CallLog (move to the kept record)': p.changeCallLogs.length,
      'CallLog naming a removed call-list row (left as is)': f.callLogsOnRemovedQueueRows,
      'InstantlyEvent (move to the kept record)': p.changeInstantly.length,
      'other tables with a foreign key to a duplicate (refuse when any)': f.otherForeignKeys,
      'OutcomeFeedback (move / drop a removed match id)': p.changeFeedback.length,
    },
    mentionsLeftAsIs: mentions === null ? '(counted in the dry run)' : { ...mentions, ...f.exactMentions },
    rowsWritten: ds1Writes(p),
    expect: p.duplicates.length,
  }
}

// ── Database ────────────────────────────────────────────────────────────────
export async function loadDs1Facts(tx: Tx, orgId: string): Promise<Ds1Facts> {
  const duplicates = await tx.$queryRawUnsafe<Ds1Duplicate[]>(`
SELECT id, "mojoId", "organizationId", "isTestData", NULLIF(metadata->>'duplicateOf', '') AS "duplicateOf",
       (metadata->>'crmLeadId') IS NOT NULL AS "hasCrmLeadId"
FROM "MojoContact" WHERE metadata->>'source' = 'duplicate' ORDER BY id`)
  const mine = duplicates.filter(d => d.organizationId === orgId && !d.isTestData)
  const dupIds = mine.map(d => d.id)
  const keeperIds = [...new Set(mine.map(d => d.duplicateOf).filter((x): x is string => !!x))]
  const keepers = await tx.$queryRawUnsafe<Ds1Keeper[]>(`
SELECT id, "organizationId", "isTestData", metadata->>'source' AS source, md5(to_jsonb(m)::text) AS hash
FROM "MojoContact" m WHERE id ${inIds(1)} ORDER BY id`, json(keeperIds))
  const D = json(dupIds)
  const sellerMatches = await tx.$queryRawUnsafe<Ds1Facts['sellerMatches']>(
    `SELECT id, "opportunityId" FROM "Match" WHERE "opportunityType" = 'contact' AND "opportunityId" ${inIds(1)} ORDER BY id`, D)
  const buyerMatches = await tx.$queryRawUnsafe<Ds1Facts['buyerMatches']>(
    `SELECT id, "counterpartId" FROM "Match" WHERE "counterpartType" = 'mojo' AND "counterpartId" ${inIds(1)} ORDER BY id`, D)
  const otherTypeMatches = await count(tx, `SELECT count(*)::int AS n FROM "Match"
WHERE ("opportunityId" ${inIds(1)} AND "opportunityType" <> 'contact') OR ("counterpartId" ${inIds(1)} AND "counterpartType" <> 'mojo')`, D)
  const S = json([...dupIds, ...keeperIds])
  const dismissals = (await tx.$queryRawUnsafe<{ id: string; partyId: string; listingId: string; dismissedAt: Date }[]>(
    `SELECT id, "partyId", "listingId", "dismissedAt" FROM "MatchDismissal" WHERE "partyId" ${inIds(1)} OR "listingId" ${inIds(1)} ORDER BY id`, S))
    .map(d => ({ ...d, dismissedAt: new Date(d.dismissedAt).toISOString() }))
  const queueOfDuplicates = await tx.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM "CallQueueEntry" WHERE "contactId" ${inIds(1)} ORDER BY id`, D)
  const removedMatchIds = json([...new Set([...sellerMatches.map(m => m.id), ...buyerMatches.map(m => m.id)])])
  const queueNamingRemoved = await tx.$queryRawUnsafe<Ds1Facts['queueNamingRemoved']>(`
SELECT id, "primaryMatchId", "contributingMatchIds" FROM "CallQueueEntry"
WHERE NOT ("contactId" ${inIds(1)}) AND ("primaryMatchId" ${inIds(2)} OR "contributingMatchIds" && ARRAY(SELECT jsonb_array_elements_text($2::jsonb)))
ORDER BY id`, D, removedMatchIds)
  const callLogs = await tx.$queryRawUnsafe<Ds1Facts['callLogs']>(
    `SELECT id, "contactId" FROM "CallLog" WHERE "contactId" ${inIds(1)} ORDER BY id`, D)
  const callLogsOnRemovedQueueRows = await count(tx,
    `SELECT count(*)::int AS n FROM "CallLog" WHERE "queueEntryId" ${inIds(1)}`, json(queueOfDuplicates.map(q => q.id)))
  const instantly = await tx.$queryRawUnsafe<Ds1Facts['instantly']>(
    `SELECT id, "contactId" FROM "InstantlyEvent" WHERE "contactId" ${inIds(1)} ORDER BY id`, D)
  const otherForeignKeys = await otherForeignKeyCounts(tx, dupIds)
  const feedback = await tx.$queryRawUnsafe<Ds1Facts['feedback']>(
    `SELECT id, "opportunityId", "matchId" FROM "OutcomeFeedback" WHERE "opportunityId" ${inIds(1)} OR "matchId" ${inIds(2)} ORDER BY id`, D, removedMatchIds)
  const exactMentions = {
    'Report.buyerId': await count(tx, `SELECT count(*)::int AS n FROM "Report" WHERE "buyerId" ${inIds(1)}`, D),
    'mojo_raw.mojoId (the copies\' spreadsheet keys)': await count(tx,
      `SELECT count(*)::int AS n FROM "mojo_raw" WHERE "mojoId" ${inIds(1)}`, json(mine.map(d => d.mojoId))),
  }
  return {
    orgId, duplicates, keepers, sellerMatches, buyerMatches, otherTypeMatches, dismissals, queueOfDuplicates,
    queueNamingRemoved, callLogs, callLogsOnRemovedQueueRows, instantly, otherForeignKeys, feedback, exactMentions,
  }
}

// Foreign keys to MojoContact.id that DS-1 doesn't move by name, read from the
// database's catalog, with how many rows point at a duplicate. Counts only.
export const HANDLED_FOREIGN_KEYS = new Set(['"CallQueueEntry"."contactId"', '"CallLog"."contactId"', '"InstantlyEvent"."contactId"'])
const IDENT = /^"?[A-Za-z_][A-Za-z0-9_]*"?$/
export async function otherForeignKeyCounts(tx: Tx, dupIds: readonly string[]): Promise<Record<string, number>> {
  const fks = await tx.$queryRawUnsafe<{ tbl: string; col: string }[]>(`
SELECT c.conrelid::regclass::text AS tbl, quote_ident(a.attname) AS col
FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
WHERE c.contype = 'f' AND c.confrelid = '"MojoContact"'::regclass AND cardinality(c.conkey) = 1
ORDER BY 1, 2`)
  const out: Record<string, number> = {}
  for (const { tbl, col } of fks) {
    const key = `${tbl}.${col}`
    if (HANDLED_FOREIGN_KEYS.has(key)) continue
    if (!IDENT.test(tbl) || !IDENT.test(col)) throw new DataStepRefusal(`Refusing: an unexpected foreign key name (${key}). Nothing changed.`)
    out[key] = dupIds.length === 0 ? 0 : await count(tx, `SELECT count(*)::int AS n FROM ${tbl} WHERE ${col} ${inIds(1)}`, json(dupIds))
  }
  return out
}

// Refusals that aren't about one duplicate's own record.
export function ds1Blockers(f: Ds1Facts): string[] {
  const hit = Object.entries(f.otherForeignKeys).filter(([, n]) => n > 0)
  return hit.length === 0 ? [] : [
    `${hit.map(([k, n]) => `${n} row(s) of ${k}`).join(', ')} point at a duplicate, and DS-1 doesn't move or copy that table.`,
  ]
}

export function ds1MentionIds(p: Ds1Plan): string[] {
  return [...p.duplicates, ...p.removeMatches]
}

async function changedRows(tx: Tx, table: Table, changes: Change[]): Promise<ChangedRow[]> {
  const before = new Map((await fetchRows(tx, table, changes.map(c => c.id))).map(r => [r.id, r]))
  return changes.map(c => {
    const row = before.get(c.id)
    if (!row) throw new DataStepRefusal(`Refusing: a ${table} row changed since it was read. Rolled back; nothing changed.`)
    return { before: row, after: c.to }
  })
}

// Inside the write transaction, after the plan was re-made and --expect
// checked: fill the before-copy, hand it to `save` (the private file is
// written there, before any write), then make every write. Returns the copy.
export async function applyDs1(tx: Tx, p: Ds1Plan, copy: BeforeCopy, keepers: Ds1Keeper[], save: (c: BeforeCopy) => string): Promise<{ file: string; copy: BeforeCopy }> {
  const removed: Record<string, Row[]> = {
    MojoContact: await fetchRows(tx, 'MojoContact', p.duplicates),
    Match: await fetchRows(tx, 'Match', p.removeMatches),
    MatchDismissal: await fetchRows(tx, 'MatchDismissal', p.removeDismissals),
    CallQueueEntry: await fetchRows(tx, 'CallQueueEntry', p.removeQueue),
  }
  const changed: Record<string, ChangedRow[]> = {
    MatchDismissal: await changedRows(tx, 'MatchDismissal', p.changeDismissals),
    CallQueueEntry: await changedRows(tx, 'CallQueueEntry', p.changeQueue),
    CallLog: await changedRows(tx, 'CallLog', p.changeCallLogs),
    InstantlyEvent: await changedRows(tx, 'InstantlyEvent', p.changeInstantly),
    OutcomeFeedback: await changedRows(tx, 'OutcomeFeedback', p.changeFeedback),
  }
  const used = new Set(Object.values(p.keeperOf))
  copy.removed = Object.fromEntries(Object.entries(removed).filter(([, rows]) => rows.length > 0))
  copy.changed = Object.fromEntries(Object.entries(changed).filter(([, rows]) => rows.length > 0))
  copy.extra = { keeperFingerprints: Object.fromEntries(keepers.filter(k => used.has(k.id)).map(k => [k.id, k.hash])), keeperOf: p.keeperOf }
  const removedCount = sum(Object.values(copy.removed).map(r => r.length))
  const changedCount = sum(Object.values(copy.changed).map(r => r.length))
  if (removedCount + changedCount !== ds1Writes(p)) throw new DataStepRefusal('Refusing: rows changed while the before-copy was made. Rolled back; nothing changed.')

  // The generation ids once the duplicates' call-list rows are gone.
  const left = await tx.$queryRawUnsafe<{ g: string }[]>(
    `SELECT DISTINCT "generationRunId" AS g FROM "CallQueueEntry" WHERE "organizationId" = $1 AND NOT (id ${inIds(2)}) ORDER BY 1`,
    copy.organizationId, json(p.removeQueue))
  copy.callListGenerations = left.map(r => r.g)

  const file = save(copy) // the before-copy exists before the first write

  // Collisions first (they free nothing the moves need, but keep the unique key clear), then moves, then removals.
  await deleteRows(tx, 'MatchDismissal', p.removeDismissals)
  await applyChanges(tx, 'MatchDismissal', p.changeDismissals)
  await applyChanges(tx, 'CallQueueEntry', p.changeQueue)
  await applyChanges(tx, 'CallLog', p.changeCallLogs)
  await applyChanges(tx, 'InstantlyEvent', p.changeInstantly)
  await applyChanges(tx, 'OutcomeFeedback', p.changeFeedback)
  await deleteRows(tx, 'CallQueueEntry', p.removeQueue)
  await deleteRows(tx, 'Match', p.removeMatches)
  // Only rows that are still duplicate copies of Ryan's organization; a foreign
  // key (call list, call log) still pointing at one fails the transaction.
  await deleteRows(tx, 'MojoContact', p.duplicates,
    `t.metadata->>'source' = 'duplicate' AND NOT t."isTestData" AND t."organizationId" = $2`, copy.organizationId)
  await auditRow(tx, copy.organizationId, DS1_ACTION, { beforeCopy: file.split('/').pop(), counts: copy.counts })
  return { file, copy }
}

// Read-only after-check, DS-1 part: nothing points at a removed duplicate, no
// call-list row or feedback names a removed match, and every kept record is
// exactly as it was (fingerprint).
export async function checkDs1(tx: Tx, copy: BeforeCopy): Promise<{ ok: boolean; counts: Record<string, number> }> {
  const dupIds = (copy.removed.MojoContact ?? []).map(r => r.id)
  const matchIds = (copy.removed.Match ?? []).map(r => r.id)
  const D = json(dupIds)
  const M = json(matchIds)
  const fingerprints = (copy.extra.keeperFingerprints ?? {}) as Record<string, string>
  const keepersNow = await tx.$queryRawUnsafe<{ id: string; hash: string }[]>(
    `SELECT id, md5(to_jsonb(m)::text) AS hash FROM "MojoContact" m WHERE id ${inIds(1)}`, json(Object.keys(fingerprints)))
  const nowById = new Map(keepersNow.map(k => [k.id, k.hash]))
  const counts = {
    'kept records changed or missing': Object.entries(fingerprints).filter(([id, h]) => nowById.get(id) !== h).length,
    'Match rows still naming a removed duplicate': await count(tx,
      `SELECT count(*)::int AS n FROM "Match" WHERE ("opportunityType" = 'contact' AND "opportunityId" ${inIds(1)}) OR ("counterpartType" = 'mojo' AND "counterpartId" ${inIds(1)})`, D),
    'MatchDismissal rows still naming a removed duplicate': await count(tx,
      `SELECT count(*)::int AS n FROM "MatchDismissal" WHERE "partyId" ${inIds(1)} OR "listingId" ${inIds(1)}`, D),
    'CallQueueEntry / CallLog / InstantlyEvent rows on a removed duplicate': await count(tx, `SELECT (
  (SELECT count(*) FROM "CallQueueEntry" WHERE "contactId" ${inIds(1)}) + (SELECT count(*) FROM "CallLog" WHERE "contactId" ${inIds(1)}) +
  (SELECT count(*) FROM "InstantlyEvent" WHERE "contactId" ${inIds(1)}))::int AS n`, D),
    'rows of other tables on a removed duplicate (foreign keys)': sum(Object.values(await otherForeignKeyCounts(tx, dupIds))),
    'CallQueueEntry / OutcomeFeedback rows naming a removed match': await count(tx, `SELECT (
  (SELECT count(*) FROM "CallQueueEntry" WHERE "primaryMatchId" ${inIds(1)} OR "contributingMatchIds" && ARRAY(SELECT jsonb_array_elements_text($1::jsonb))) +
  (SELECT count(*) FROM "OutcomeFeedback" WHERE "matchId" ${inIds(1)}))::int AS n`, M),
    'OutcomeFeedback rows naming a removed duplicate': await count(tx, `SELECT count(*)::int AS n FROM "OutcomeFeedback" WHERE "opportunityId" ${inIds(1)}`, D),
  }
  return { ok: Object.values(counts).every(n => n === 0), counts }
}

export function newDs1Copy(database: string, orgId: string, now: Date, p: Ds1Plan, summary: Record<string, unknown>): BeforeCopy {
  const copy = emptyBeforeCopy('DS-1', database, orgId, now)
  copy.expect = p.duplicates.length
  copy.counts = summary
  return copy
}

export const ds1Step: Step<{ plan: Ds1Plan; facts: Ds1Facts }> = {
  id: 'DS-1',
  title: 'remove the duplicate spreadsheet copies',
  unit: 'duplicate copies',
  restoreAction: DS1_RESTORE_ACTION,
  lockTables: ['Match', 'MatchDismissal', 'OutcomeFeedback', 'CallQueueEntry'],
  async plan(tx, orgId, _argv, mentions) {
    const facts = await loadDs1Facts(tx, orgId)
    const plan = planDs1(facts)
    const m = mentions ?? await countMentions(tx, ds1MentionIds(plan))
    const refusals = [
      ...Object.entries(plan.refusals).filter(([, ids]) => ids.length > 0)
        .map(([reason, ids]) => `${ids.length} duplicate(s): ${reason} (${someIds(ids, 10).join(', ')}).`),
      ...ds1Blockers(facts),
    ]
    return { plan: { plan, facts }, expect: plan.duplicates.length, summary: ds1Summary(plan, facts, m), refusals, notices: [], mentions: m }
  },
  newCopy: (database, orgId, now, r) => newDs1Copy(database, orgId, now, r.plan.plan, r.summary),
  apply: async (tx, r, copy, save) => (await applyDs1(tx, r.plan.plan, copy, r.plan.facts.keepers, save)).file,
  check: checkDs1,
}

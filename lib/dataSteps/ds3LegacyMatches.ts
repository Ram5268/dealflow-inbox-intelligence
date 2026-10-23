// Brief 48 data step DS-3: remove the old matcher's leftover match rows
// [Brief 48 §4, from PR 1; pre-approved by Ryan 2026-10-19].
//
// The old matcher (lib/matchmaking.ts runMatchmaking, called by Check In until
// PR 1) wrote Match rows with no tier and one of five notes. One of them puts a
// homeowner's full name and address in the note ("Mojo lead <name> at
// <address> may match ISO: <title>"), which the CRM's morning copy can show as
// the "Why" line. This step finds them by that note, anchored at both ends, and
// by the row's shape (no tier, opportunityType 'opportunity', the counterpart
// type that note was written with, and the note's score equal to the row's).
// Nothing else writes those shapes: the nightly and the 7.0 engine always set a
// tier, showing confirmations use counterpartType 'showing_confirmation', and
// the hotsheet tool's "<address> (hotsheet) may match …" notes (kept, Ryan 1.9)
// are excluded by name [engineering precaution].
//
// If anything uses them (the call list's primaryMatchId / contributingMatchIds,
// OutcomeFeedback.matchId, Drift's interaction rows, chat, reports), the dry
// run reports the counts and --apply refuses unless --allow-referenced. With
// it, the call list and feedback drop those match ids (the nightly rebuilds the
// list anyway); chat, Drift, report and log text is left as is. The AuditLog
// mentions are counted but never block (they're history).
import { DataStepRefusal, emptyBeforeCopy, sum, type BeforeCopy, type ChangedRow } from './common'
import {
  MENTION_TARGETS, applyChanges, auditRow, callListGenerations, count, countMentions, deleteRows, fetchRows, inIds, json,
  type Change, type Tx,
} from './rows'
import type { Step } from './runner'

export const DS3_ACTION = 'BRIEF48_DS3_OLD_MATCHES_REMOVED'
export const DS3_RESTORE_ACTION = 'BRIEF48_DS3_RESTORED'
export const ALLOW_REFERENCED_FLAG = '--allow-referenced'

export type LegacyKind = 'listing_iso' | 'listing_renter' | 'iso_listing' | 'mojo_lead_iso' | 'renter_listing'

// The five notes of lib/matchmaking.ts (unchanged since it was written), anchored
// at both ends. [\s\S] so a title with a line break still matches; no lookarounds.
const NOTE: { kind: LegacyKind; counterpartType: 'opportunity' | 'mojo'; re: RegExp; scored: boolean }[] = [
  // `Renter inquiry may match ${rental.extractedTitle} (score ${score})`
  { kind: 'renter_listing', counterpartType: 'opportunity', re: /^Renter inquiry may match [\s\S]* \(score (-?\d+)\)$/, scored: true },
  // `ISO: ${iso.extractedTitle} may match ${listing.extractedTitle} (score ${score})`
  { kind: 'iso_listing', counterpartType: 'opportunity', re: /^ISO: [\s\S]* may match [\s\S]* \(score (-?\d+)\)$/, scored: true },
  // `${listing.extractedTitle} may match renter: ${inq.extractedTitle} (score ${score})`
  { kind: 'listing_renter', counterpartType: 'opportunity', re: /^[\s\S]* may match renter: [\s\S]* \(score (-?\d+)\)$/, scored: true },
  // `${listing.extractedTitle} may match ISO: ${iso.extractedTitle} (score ${score})`
  { kind: 'listing_iso', counterpartType: 'opportunity', re: /^[\s\S]* may match ISO: [\s\S]* \(score (-?\d+)\)$/, scored: true },
  // `Mojo lead ${mojo.fullName} at ${mojo.address} may match ISO: ${iso.extractedTitle}` (no score in the note)
  { kind: 'mojo_lead_iso', counterpartType: 'mojo', re: /^Mojo lead [\s\S]* at [\s\S]* may match ISO: [\s\S]*$/, scored: false },
]

export interface MatchShape {
  reason: string | null
  tier: string | null
  opportunityType: string
  counterpartType: string
  score: number
  opportunityAddress?: string | null // the opportunity's address, to tell hotsheet notes apart
}

// lib/streetEasyHotsheet.ts: `${listing.address} (hotsheet) may match ${demand.extractedTitle} (score ${score})`
export function isHotsheetNote(m: Pick<MatchShape, 'reason' | 'opportunityAddress'>): boolean {
  if (!m.reason) return false
  if (m.opportunityAddress && m.reason.startsWith(`${m.opportunityAddress} (hotsheet) may match `)) return true
  return m.reason.includes(' (hotsheet) may match ') // when unsure, keep the row
}

// Which old-matcher note this row is, or null. Pure.
export function legacyKind(m: MatchShape): LegacyKind | null {
  if (m.tier !== null || m.opportunityType !== 'opportunity' || !m.reason || isHotsheetNote(m)) return null
  for (const n of NOTE) {
    if (m.counterpartType !== n.counterpartType) continue
    const hit = n.re.exec(m.reason)
    if (!hit) continue
    if (n.scored && Number(hit[1]) !== m.score) continue
    return n.kind
  }
  return null
}

// The note alone, ignoring the row's shape: rows that look like the old
// matcher's but aren't counted as its (reported, never removed).
export function looksLegacy(reason: string | null): boolean {
  return !!reason && NOTE.some(n => n.re.test(reason))
}

// ── Database ────────────────────────────────────────────────────────────────
export interface Ds3Candidate extends MatchShape { id: string; organizationId: string }

export interface Ds3Facts {
  orgId: string
  candidates: Ds3Candidate[] // tier-null rows whose note says "may match"
  queueNaming: { id: string; primaryMatchId: string | null; contributingMatchIds: string[] }[]
  feedback: { id: string; opportunityId: string | null; matchId: string | null }[]
  mentions: Record<string, number> | null
}

export async function loadDs3Candidates(tx: Tx): Promise<Ds3Candidate[]> {
  // Every organization, to count other organizations' rows; only Ryan's are removed.
  return tx.$queryRawUnsafe<Ds3Candidate[]>(`
SELECT m.id, m."organizationId", m.reason, m.tier::text AS tier, m."opportunityType", m."counterpartType", m.score,
       o.address AS "opportunityAddress"
FROM "Match" m LEFT JOIN "ExtractedOpportunity" o ON o.id = m."opportunityId"
WHERE m.tier IS NULL AND strpos(m.reason, ' may match ') > 0
ORDER BY m.id`)
}

export interface Ds3Plan {
  remove: string[] // Ryan's organization's old-matcher rows
  byKind: Record<LegacyKind, number>
  otherOrganizations: number
  nearMisses: number // look like old-matcher notes but don't have its shape: kept
  hotsheetKept: number
  changeQueue: Change[]
  changeFeedback: Change[]
  gatingMentions: number
  referenced: boolean
}

// Mentions that count as "something uses them"; AuditLog is history and never blocks.
export const GATING_MENTIONS = MENTION_TARGETS.filter(t => t.table !== 'AuditLog').map(t => t.label)

// Pure.
export function planDs3(orgId: string, candidates: Ds3Candidate[], queue: Ds3Facts['queueNaming'], feedback: Ds3Facts['feedback'], mentions: Record<string, number> | null): Ds3Plan {
  const byKind = { listing_iso: 0, listing_renter: 0, iso_listing: 0, mojo_lead_iso: 0, renter_listing: 0 } as Record<LegacyKind, number>
  const remove: string[] = []
  let otherOrganizations = 0
  let nearMisses = 0
  let hotsheetKept = 0
  for (const c of candidates) {
    const kind = legacyKind(c)
    if (!kind) {
      if (isHotsheetNote(c)) hotsheetKept++
      else if (looksLegacy(c.reason)) nearMisses++
      continue
    }
    if (c.organizationId !== orgId) { otherOrganizations++; continue }
    byKind[kind]++
    remove.push(c.id)
  }
  remove.sort()
  const removed = new Set(remove)
  const changeQueue: Change[] = queue.map(q => ({
    id: q.id,
    from: { primaryMatchId: q.primaryMatchId, contributingMatchIds: q.contributingMatchIds },
    to: {
      primaryMatchId: q.primaryMatchId && removed.has(q.primaryMatchId) ? null : q.primaryMatchId,
      contributingMatchIds: q.contributingMatchIds.filter(id => !removed.has(id)),
    },
  }))
  const changeFeedback: Change[] = feedback.map(r => ({
    id: r.id, from: { opportunityId: r.opportunityId, matchId: r.matchId }, to: { opportunityId: r.opportunityId, matchId: null },
  }))
  const gatingMentions = mentions ? sum(GATING_MENTIONS.map(l => mentions[l] ?? 0)) : 0
  return {
    remove, byKind, otherOrganizations, nearMisses, hotsheetKept, changeQueue, changeFeedback, gatingMentions,
    referenced: changeQueue.length + changeFeedback.length + gatingMentions > 0,
  }
}

export async function loadDs3Refs(tx: Tx, ids: string[]): Promise<Pick<Ds3Facts, 'queueNaming' | 'feedback'>> {
  const M = json(ids)
  return {
    queueNaming: await tx.$queryRawUnsafe<Ds3Facts['queueNaming']>(`
SELECT id, "primaryMatchId", "contributingMatchIds" FROM "CallQueueEntry"
WHERE "primaryMatchId" ${inIds(1)} OR "contributingMatchIds" && ARRAY(SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY id`, M),
    feedback: await tx.$queryRawUnsafe<Ds3Facts['feedback']>(
      `SELECT id, "opportunityId", "matchId" FROM "OutcomeFeedback" WHERE "matchId" ${inIds(1)} ORDER BY id`, M),
  }
}

export function ds3Summary(p: Ds3Plan, mentions: Record<string, number> | null) {
  return {
    oldMatcherRows: { toRemove: p.remove.length, byNote: p.byKind, inOtherOrganizations: p.otherOrganizations },
    kept: { hotsheetNotes: p.hotsheetKept, lookAlikesWithAnotherShape: p.nearMisses },
    usedBy: {
      'CallQueueEntry naming one (drop the match id)': p.changeQueue.length,
      'OutcomeFeedback naming one (matchId → null)': p.changeFeedback.length,
      'mentions in chat, Drift and reports (left as is)': p.gatingMentions,
    },
    referenced: p.referenced,
    mentionsLeftAsIs: mentions ?? '(counted in the dry run)',
    rowsWritten: p.remove.length + p.changeQueue.length + p.changeFeedback.length,
    expect: p.remove.length,
  }
}

export function ds3Refusals(p: Ds3Plan, allowReferenced: boolean): string[] {
  if (!p.referenced || allowReferenced) return []
  return [`Something still uses these rows (${p.changeQueue.length} call-list row(s), ${p.changeFeedback.length} feedback row(s), ` +
    `${p.gatingMentions} chat/Drift/report mention(s)); add ${ALLOW_REFERENCED_FLAG} to remove them anyway.`]
}

export function newDs3Copy(database: string, orgId: string, now: Date, p: Ds3Plan, summary: Record<string, unknown>): BeforeCopy {
  const copy = emptyBeforeCopy('DS-3', database, orgId, now)
  copy.expect = p.remove.length
  copy.counts = summary
  return copy
}

async function changedRows(tx: Tx, table: 'CallQueueEntry' | 'OutcomeFeedback', changes: Change[]): Promise<ChangedRow[]> {
  const before = new Map((await fetchRows(tx, table, changes.map(c => c.id))).map(r => [r.id, r]))
  return changes.map(c => {
    const row = before.get(c.id)
    if (!row) throw new DataStepRefusal(`Refusing: a ${table} row changed since it was read. Rolled back; nothing changed.`)
    return { before: row, after: c.to }
  })
}

// Inside the write transaction, after the plan was re-made and --expect checked.
export async function applyDs3(tx: Tx, p: Ds3Plan, copy: BeforeCopy, save: (c: BeforeCopy) => string): Promise<string> {
  const removed = await fetchRows(tx, 'Match', p.remove)
  if (removed.length !== p.remove.length) throw new DataStepRefusal('Refusing: match rows changed while the before-copy was made. Rolled back; nothing changed.')
  copy.removed = { Match: removed }
  const queue = await changedRows(tx, 'CallQueueEntry', p.changeQueue)
  const feedback = await changedRows(tx, 'OutcomeFeedback', p.changeFeedback)
  copy.changed = Object.fromEntries(Object.entries({ CallQueueEntry: queue, OutcomeFeedback: feedback }).filter(([, r]) => r.length > 0))
  copy.callListGenerations = await callListGenerations(tx, copy.organizationId)
  const file = save(copy)
  await applyChanges(tx, 'CallQueueEntry', p.changeQueue)
  await applyChanges(tx, 'OutcomeFeedback', p.changeFeedback)
  // Only rows that still have the old matcher's shape.
  await deleteRows(tx, 'Match', p.remove, `t.tier IS NULL AND t."opportunityType" = 'opportunity' AND t."organizationId" = $2`, copy.organizationId)
  await auditRow(tx, copy.organizationId, DS3_ACTION, { beforeCopy: file.split('/').pop(), counts: copy.counts })
  return file
}

// Read-only after-check, DS-3 part: no old-matcher row is left in Ryan's
// organization, and nothing names a removed one.
export async function checkDs3(tx: Tx, copy: BeforeCopy): Promise<{ ok: boolean; counts: Record<string, number> }> {
  const ids = (copy.removed.Match ?? []).map(r => r.id)
  const left = (await loadDs3Candidates(tx)).filter(c => c.organizationId === copy.organizationId && legacyKind(c) !== null).length
  const refs = await loadDs3Refs(tx, ids)
  const counts = {
    'old-matcher rows left in the organization': left,
    'call-list rows naming a removed match': refs.queueNaming.length,
    'feedback rows naming a removed match': refs.feedback.length,
    'removed rows still there': await count(tx, `SELECT count(*)::int AS n FROM "Match" WHERE id ${inIds(1)}`, json(ids)),
  }
  return { ok: Object.values(counts).every(n => n === 0), counts }
}

export const ds3Step: Step<Ds3Plan> = {
  id: 'DS-3',
  title: "remove the old matcher's leftover match rows",
  unit: 'old-matcher rows',
  restoreAction: DS3_RESTORE_ACTION,
  async plan(tx, orgId, argv, mentions) {
    const candidates = await loadDs3Candidates(tx)
    const ids = planDs3(orgId, candidates, [], [], null).remove
    const refs = await loadDs3Refs(tx, ids)
    const m = mentions ?? await countMentions(tx, ids)
    const plan = planDs3(orgId, candidates, refs.queueNaming, refs.feedback, m)
    const allow = argv.includes(ALLOW_REFERENCED_FLAG)
    const notices = plan.referenced && allow
      ? [`${ALLOW_REFERENCED_FLAG} given: the call list and feedback drop the removed match ids; chat, Drift, report and log text stays as is.`]
      : []
    return { plan, expect: plan.remove.length, summary: ds3Summary(plan, m), refusals: ds3Refusals(plan, allow), notices, mentions: m }
  },
  newCopy: (database, orgId, now, r) => newDs3Copy(database, orgId, now, r.plan, r.summary),
  apply: (tx, r, copy, save) => applyDs3(tx, r.plan, copy, save),
  check: checkDs3,
}

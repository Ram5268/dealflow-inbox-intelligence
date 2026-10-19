// Brief 47 (PR 4), Brief 46's DF-3: "what happened last night", for the public status page
// GET /api/debug/health (no login, by Ryan's design). Ryan asked (2026-10-18) why Brief 44
// had to rely on him to ask for a morning check: nothing told anyone how the nightly went,
// and the valuation switch turning itself off left only an AuditLog row. This reads the
// newest row of each nightly step, the switch, the refusals, the other switches and this
// month's RapidAPI calls.
//
// Counts, times, booleans and reason codes only: no ids, names, addresses, values, or
// whether any key is set (engineering precaution: the page is public). A number is copied
// out of a row's detailsJson by name, and only when it is a number; a reason code only
// when it looks like one. Reads only (findFirst / findUnique).
//
// Times come from Prisma (toISOString(), UTC). AuditLog."createdAt" holds UTC without a
// zone: Prisma reads it correctly, while raw node-pg on a non-UTC machine (this Mac) reads
// it as local time, 4 hours late. Keep these reads on Prisma (engineering precaution).
import type { PrismaClient } from '@prisma/client'
import { ROLLBACK_ACTION, USE_OUR_ESTIMATES, switchIsOn } from '../matching/ourEstimates'
import { graphEnabled } from '../graphAccess'
import { maintenanceEnabled } from '../config/maintenance'
import { isTestModeOnly } from '../config/testMode'

// The nightly's three steps (lib/crm-sync/runSync.ts, lib/matching/nightly/runScoring.ts,
// lib/ranking/queueBuilder.ts persistBatch), one AuditLog row each per night.
export const CRM_LEAD_SYNC = 'CRM_LEAD_SYNC'
export const NIGHTLY_SCORING = 'NIGHTLY_SCORING'
export const CALL_QUEUE_BUILD = 'CALL_QUEUE_BUILD'
// Written by the nightly, Brief 47 PR 1, when its size checks refuse a night (literal
// strings, as pinned in Brief 47's CONTRACT.md).
export const NIGHTLY_SCORING_REFUSED = 'NIGHTLY_SCORING_REFUSED'
export const CALL_QUEUE_BUILD_REFUSED = 'CALL_QUEUE_BUILD_REFUSED'

export type AuditRow = { createdAt: Date; detailsJson: unknown }
type Details = Record<string, unknown>

const details = (v: unknown): Details => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Details) : {})
const count = (d: Details, key: string): number | null => {
  const v = d[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
const iso = (d: unknown): string | null => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null)

// Only the known reason codes are copied: Brief 44's rollback codes
// (lib/matching/ourEstimates.ts RollbackReason) and Brief 47 PR 1's refusal codes
// (CONTRACT.md). Anything else, even a lower-case word like 'jane_example', is dropped,
// and each code shows once (engineering precaution: the page is public).
const KNOWN_REASONS = new Set([
  'error', 'hot_halved', 'sellers_lost_matches',
  'no_sellers', 'no_buyers', 'matches_shrank', 'sellers_shrank', 'empty_list',
])
export const reasonCodes = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((r): r is string => typeof r === 'string' && KNOWN_REASONS.has(r)))] : []

// ── Pure mappers: an AuditLog row (or none) to what the page shows ─────────────

export function mapCrmLeadSync(row: AuditRow | null) {
  if (!row) return null
  const d = details(row.detailsJson)
  return {
    finishedAt: iso(row.createdAt),
    crmLeads: count(d, 'crmLeads'),
    inserted: count(d, 'inserted'),
    updated: count(d, 'updated'),
    rekeyed: count(d, 'rekeyed'),
    duplicatesMarked: count(d, 'duplicatesMarked'),
    legacyMarked: count(d, 'legacyMarked'),
    removedMarked: count(d, 'removedMarked'),
  }
}

// "Last night used our values": the newest NIGHTLY_SCORING row has ourEstimates (only on a
// night the USE_OUR_ESTIMATES switch was on) and it wasn't rolled back. null: no night yet.
export function usedOurValues(row: AuditRow | null): boolean | null {
  if (!row) return null
  return details(details(row.detailsJson).ourEstimates).rolledBack === false
}

export function mapScoring(row: AuditRow | null) {
  if (!row) return null
  const d = details(row.detailsJson)
  const tiers = details(d.tiers)
  return {
    finishedAt: iso(row.createdAt),
    sellers: count(d, 'sellers'),
    buyers: count(d, 'buyers'),
    kept: count(d, 'kept'),
    tiers: { HOT: count(tiers, 'HOT') ?? 0, WARM: count(tiers, 'WARM') ?? 0, POSSIBLE: count(tiers, 'POSSIBLE') ?? 0 },
    sellersPricedByOurValues: usedOurValues(row) ? count(details(d.ourEstimates), 'sellersPricedByOurValue') ?? 0 : 0,
  }
}

export function mapCallQueue(row: AuditRow | null) {
  if (!row) return null
  const d = details(row.detailsJson)
  return {
    finishedAt: iso(row.createdAt),
    queueLength: count(d, 'queueLength'),
    totalContactsConsidered: count(d, 'totalContactsConsidered'),
  }
}

// A rollback or a refusal: when, and its reason codes.
export function mapReasons(row: AuditRow | null) {
  if (!row) return null
  return { at: iso(row.createdAt), reasons: reasonCodes(details(row.detailsJson).reasons) }
}

// ── The switches ───────────────────────────────────────────────────────────────

export function readSwitches() {
  return {
    outlook: graphEnabled(),
    maintenance: maintenanceEnabled(),
    // As app/api/instantly/enroll/route.ts checks it (Brief 34 kill switch). The route
    // also refuses while TEST_MODE_ONLY is on, so true here can overstate, never understate.
    instantly: process.env.INSTANTLY_ENROLL_ENABLED === 'true',
    // The gate on lib/streetEasySync.ts's sweep / stale-marking entry points: paused when
    // STREETEASY_SYNC_ENABLED is 'false' or TEST_MODE_ONLY is on. Worked out here rather
    // than imported: that module creates the database client and logs when it loads, and
    // keeps both gates in unexported constants.
    streetEasySync: process.env.STREETEASY_SYNC_ENABLED !== 'false' && !isTestModeOnly(),
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────────

type StatusDb = Pick<PrismaClient, 'auditLog' | 'featureFlag' | 'rapidApiUsage'>
export type Safe = <T>(label: string, fn: () => Promise<T>, fallback: T) => Promise<T>

export function newestAudit(db: Pick<PrismaClient, 'auditLog'>, action: string): Promise<AuditRow | null> {
  return db.auditLog.findFirst({ where: { action }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, detailsJson: true } })
}

// Not readOurEstimatesSwitch(): that one counts a failed read as off (the safe side for
// scoring); here a failed read must show as unknown (null, from safe()).
export async function readOurEstimatesFlag(db: Pick<PrismaClient, 'featureFlag'>): Promise<boolean> {
  return switchIsOn(await db.featureFlag.findUnique({ where: { id: USE_OUR_ESTIMATES }, select: { enabled: true } }))
}

// The month key lib/streetEasySync.ts counts RapidAPI calls under (UTC).
export const yearMonth = (now: Date) => now.toISOString().slice(0, 7)

export async function readRapidApiCalls(db: Pick<PrismaClient, 'rapidApiUsage'>, month: string): Promise<number> {
  const row = await db.rapidApiUsage.findUnique({ where: { yearMonth: month }, select: { callsConsumed: true } })
  return row?.callsConsumed ?? 0 // no row yet: no calls this month
}

// The whole status window. Each read is best-effort through the route's safe(): one failing
// query blanks only its own block (null), never the page.
export async function readStatusWindow(db: StatusDb, safe: Safe, now: Date = new Date()) {
  const newest = (action: string) => safe<AuditRow | null>(`status ${action}`, () => newestAudit(db, action), null)
  const month = yearMonth(now)
  const [sync, scoring, queue, rollback, scoringRefusal, callListRefusal, useOurEstimates, calls] = await Promise.all([
    newest(CRM_LEAD_SYNC),
    newest(NIGHTLY_SCORING),
    newest(CALL_QUEUE_BUILD),
    newest(ROLLBACK_ACTION),
    newest(NIGHTLY_SCORING_REFUSED),
    newest(CALL_QUEUE_BUILD_REFUSED),
    safe<boolean | null>(`status ${USE_OUR_ESTIMATES}`, () => readOurEstimatesFlag(db), null),
    safe<number | null>('status rapidApi', () => readRapidApiCalls(db, month), null),
  ])
  return {
    lastNight: {
      crmLeadSync: mapCrmLeadSync(sync),
      scoring: mapScoring(scoring),
      callQueue: mapCallQueue(queue),
    },
    valuationSwitch: {
      useOurEstimates,
      lastNightUsedOurValues: usedOurValues(scoring),
      lastRollback: mapReasons(rollback),
      lastScoringRefusal: mapReasons(scoringRefusal),
      lastCallListRefusal: mapReasons(callListRefusal),
    },
    switches: readSwitches(),
    rapidApi: { month, calls },
  }
}

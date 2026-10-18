// Brief 44 (PR 4): nightly matching can use DealFlow's own published values, behind a
// switch: the FeatureFlag row USE_OUR_ESTIMATES (Brief 44 §5), read once per scoring run.
//   • Off (no row, enabled false or anything else, or a failed read): scoring is exactly
//     as before, and nothing else is read.
//   • On: each CRM seller without a last asking price is priced by the value of its newest
//     published valuation (a run that passed the job's publish checks), through the
//     existing chance-based price fit (sellerPrice.ts), and the few-alternatives counts are
//     redone with those prices. An expired or withdrawn listing keeps its last asking price,
//     as PR #14 does.
// The values reach matching in memory only. Nothing here writes them anywhere (never into
// MojoContact), and they stay out of anything a buyer or homeowner could see (Ryan's
// decision, 2026-10-17: the fit line never names a homeowner's price, fitReason.ts).
//
// With the switch on, the nightly job also scores the same night without our values and,
// when ours fail the rollback checks below, keeps those results instead, writes an AuditLog
// row and turns the switch off (Brief 44 data step V4, step 4, built into the job so it
// holds on every night: an engineering precaution).
import type { Prisma, PrismaClient } from '@prisma/client'
import type { BuyerData, ListingData, ScoringContext } from './scorerTypes'
import { sellerPrice } from './sellerPrice'
import { precomputeSubstitutionCounts } from './compsCache'
import { tierOf, type Candidate } from './nightly/select'

export const USE_OUR_ESTIMATES = 'USE_OUR_ESTIMATES'
export const ROLLBACK_ACTION = 'VALUATION_SWITCH_ROLLBACK'

// Only an error's class reaches the log: its message could quote a query.
const className = (e: unknown) => (e instanceof Error ? e.constructor.name : 'unknown')
const usable = (v: number | null | undefined): v is number => v != null && Number.isFinite(v) && v > 0

// ── The switch ──────────────────────────────────────────────────────────────

export function switchIsOn(row: unknown): boolean {
  return typeof row === 'object' && row !== null && (row as { enabled?: unknown }).enabled === true
}

// A read that fails counts as off: scoring as before is the safe side (engineering precaution).
export async function readOurEstimatesSwitch(db: Pick<PrismaClient, 'featureFlag'>): Promise<boolean> {
  try {
    return switchIsOn(await db.featureFlag.findUnique({ where: { id: USE_OUR_ESTIMATES }, select: { enabled: true } }))
  } catch (e) {
    console.warn(`[scoring] the ${USE_OUR_ESTIMATES} switch couldn't be read (${className(e)}): scoring without our values`)
    return false
  }
}

// ── Our published values ────────────────────────────────────────────────────

export interface PublishedValueRow {
  contactId: string
  value: number | null
  createdAt: Date
  run: { publishedAt: Date | null }
}

// "Newest" as everywhere in Brief 44: the run published last (publishedAt DESC NULLS
// LAST), then the newer row.
const publishedTime = (r: PublishedValueRow) => r.run.publishedAt?.getTime() ?? -Infinity
const newer = (a: PublishedValueRow, b: PublishedValueRow) =>
  publishedTime(a) > publishedTime(b) || (publishedTime(a) === publishedTime(b) && a.createdAt.getTime() > b.createdAt.getTime())

// Each seller's value from its newest published valuation, the one the CRM card shows.
// When that valuation has no value (a home the model can't value), the seller gets none:
// an older month's value is never used (engineering precaution).
export function newestPublishedValues(rows: PublishedValueRow[]): Map<string, number> {
  const newest = new Map<string, PublishedValueRow>()
  for (const r of rows) {
    const seen = newest.get(r.contactId)
    if (!seen || newer(r, seen)) newest.set(r.contactId, r)
  }
  const values = new Map<string, number>()
  for (const [contactId, r] of newest) if (usable(r.value)) values.set(contactId, r.value)
  return values
}

// Valuations of published runs only. The import keeps the values of the 12 most recent
// published runs, so this is at most about a dozen rows per seller.
export async function loadPublishedValues(db: Pick<PrismaClient, 'propertyValuation'>, orgId: string): Promise<Map<string, number>> {
  const rows = await db.propertyValuation.findMany({
    where: { organizationId: orgId, run: { published: true } },
    select: { contactId: true, value: true, createdAt: true, run: { select: { publishedAt: true } } },
  })
  return newestPublishedValues(rows)
}

// ── Pricing the sellers ─────────────────────────────────────────────────────

// Pure. A CRM seller with a value and no last asking price gets price = estimatedValue =
// our value, marked ourEstimate (the buyer-type factor reads that as a chance). Every
// other listing passes through as it is; the listings given are never changed.
export function applyOurEstimates(listings: ListingData[], values: ReadonlyMap<string, number>): ListingData[] {
  return listings.map(l => {
    if (l.sourceType !== 'contact' || sellerPrice(l)?.basis === 'last_asking') return l
    const value = values.get(l.id)
    return usable(value) ? { ...l, price: value, estimatedValue: value, ourEstimate: true } : l
  })
}

export interface OurEstimates {
  applied: number // CRM sellers priced by our value
  failed: boolean // our values couldn't be used: the night is scored without them
  without: { listings: ListingData[]; ctx: ScoringContext } // the same inputs with the switch off
}

// Reads the switch (once per scoring run) and, when it's on, prices the sellers by our
// values and redoes the few-alternatives counts with those prices, so each buyer's count
// sees the prices the buyer is scored against. Off: the same inputs back.
export async function withOurEstimates<T extends { listings: ListingData[]; buyers: BuyerData[]; ctx: ScoringContext }>(
  db: Pick<PrismaClient, 'featureFlag' | 'propertyValuation'>,
  orgId: string,
  inputs: T,
): Promise<T & { ourEstimates?: OurEstimates }> {
  if (!(await readOurEstimatesSwitch(db))) return inputs
  const without = { listings: inputs.listings, ctx: inputs.ctx }
  try {
    const listings = applyOurEstimates(inputs.listings, await loadPublishedValues(db, orgId))
    const ctx: ScoringContext = { ...inputs.ctx, substitutionCounts: precomputeSubstitutionCounts(inputs.buyers, listings) }
    const applied = listings.filter(l => l.ourEstimate === true).length
    return { ...inputs, listings, ctx, ourEstimates: { applied, failed: false, without } }
  } catch (e) {
    console.error(`[scoring] our published values couldn't be used (${className(e)}): scoring without them`)
    return { ...inputs, ourEstimates: { applied: 0, failed: true, without } }
  }
}

// ── Automatic rollback (Brief 44 data step V4, step 4) ─────────────────────

export type RollbackReason = 'error' | 'hot_halved' | 'sellers_lost_matches'

// Counts and reason codes only: it is written to AuditLog.
export type SwitchCheck = {
  rolledBack: boolean
  reasons: RollbackReason[]
  sellersPricedByOurValue: number
  hotWithout: number
  hotWith: number | null
  sellersWithMatchesWithout: number
  sellersLosingAllMatches: number | null
}

// Brief 44 V4's rollback rules, checked on every night the switch is on (engineering
// precautions): scoring with our values failed, or gave a score that isn't a number (that
// would fail the night's write); HOT matches with our values fell below half of those
// without; more than 10% of the CRM sellers with matches without our values have none.
export const MIN_HOT_SHARE = 0.5
export const MAX_SELLERS_LOST_SHARE = 0.1

type Kept = Pick<Candidate, 'sellerId'> & { matchFit: Pick<Candidate['matchFit'], 'matchFit'> }
const hotCount = (kept: Kept[]) => kept.filter(k => tierOf(k.matchFit.matchFit) === 'HOT').length

export function rollbackCheck(without: Kept[], withOurs: Kept[] | null, sellersPricedByOurValue: number): SwitchCheck {
  const covered = new Set(without.map(k => k.sellerId))
  const hotWithout = hotCount(without)
  if (withOurs == null || !withOurs.every(k => Number.isFinite(k.matchFit.matchFit))) {
    return {
      rolledBack: true, reasons: ['error'], sellersPricedByOurValue,
      hotWithout, hotWith: null, sellersWithMatchesWithout: covered.size, sellersLosingAllMatches: null,
    }
  }
  const coveredWith = new Set(withOurs.map(k => k.sellerId))
  const hotWith = hotCount(withOurs)
  const lost = [...covered].filter(s => !coveredWith.has(s)).length
  const reasons: RollbackReason[] = []
  if (hotWith < hotWithout * MIN_HOT_SHARE) reasons.push('hot_halved')
  if (lost > covered.size * MAX_SELLERS_LOST_SHARE) reasons.push('sellers_lost_matches')
  return {
    rolledBack: reasons.length > 0, reasons, sellersPricedByOurValue,
    hotWithout, hotWith, sellersWithMatchesWithout: covered.size, sellersLosingAllMatches: lost,
  }
}

// The night with the switch on, scored both ways in memory: ours, unless they fail the
// check; then the results without our values.
export function pickTonight<R extends { kept: Kept[] }>(
  ours: OurEstimates,
  scoreWithOurs: () => R,
  scoreWithout: () => R,
): { result: R; check: SwitchCheck } {
  const without = scoreWithout()
  let withOurs: R | null = null
  if (!ours.failed) {
    try {
      withOurs = scoreWithOurs()
    } catch (e) {
      console.error(`[scoring] scoring with our values failed (${className(e)}): using the results without them`)
    }
  }
  const check = rollbackCheck(without.kept, withOurs?.kept ?? null, ours.applied)
  return { result: check.rolledBack || withOurs == null ? without : withOurs, check }
}

// In the night's write transaction: one AuditLog row (counts only), then the switch goes
// back off. It stays off until someone turns it on again (scripts/valuation-switch.ts).
export async function recordRollback(
  tx: Pick<Prisma.TransactionClient, 'auditLog' | 'featureFlag'>,
  orgId: string,
  check: SwitchCheck,
): Promise<void> {
  await tx.auditLog.create({ data: { organizationId: orgId, action: ROLLBACK_ACTION, detailsJson: check } })
  await tx.featureFlag.updateMany({ where: { id: USE_OUR_ESTIMATES }, data: { enabled: false } })
}

// ── scripts/valuation-switch.ts ─────────────────────────────────────────────

export const SWITCH_USAGE = 'usage: npx tsx scripts/valuation-switch.ts [--on | --off] [--apply [--i-mean-live]]'

// The script's own arguments (dbGuard's scriptArgs: without --apply, --dry-run, --i-mean-live).
export function parseSwitchArgs(args: readonly string[]): 'on' | 'off' | null | 'usage' {
  if (args.length === 0) return null
  if (args.length === 1 && args[0] === '--on') return 'on'
  if (args.length === 1 && args[0] === '--off') return 'off'
  return 'usage'
}

const describeSwitch = (row: { enabled: boolean } | null) => (row == null ? 'off (no row)' : switchIsOn(row) ? 'on' : 'off')

// The switch's state; with --on or --off and --apply, the change. Lines of output: the
// state only.
export async function runSwitchCommand(
  db: Pick<PrismaClient, 'featureFlag'>,
  wanted: 'on' | 'off' | null,
  apply: boolean,
): Promise<string[]> {
  const row = await db.featureFlag.findUnique({ where: { id: USE_OUR_ESTIMATES }, select: { enabled: true } })
  const state = `${USE_OUR_ESTIMATES}: ${describeSwitch(row)}`
  if (wanted == null) return [state]
  const enabled = wanted === 'on'
  if (enabled === switchIsOn(row)) return [`${state}, unchanged`]
  if (!apply) return [state, `Dry run: nothing changed. Add --apply to turn it ${wanted}.`]
  await db.featureFlag.upsert({ where: { id: USE_OUR_ESTIMATES }, update: { enabled }, create: { id: USE_OUR_ESTIMATES, enabled } })
  return [`${state} -> ${wanted}`]
}

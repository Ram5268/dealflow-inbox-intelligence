// Brief 41 (H5), made safe in Brief 41.1 (PR H): which listings to restore
// after the old StreetEasy lookup marked them delisted on a miss (no
// StreetEasy id), and how to apply that. No DB client and no network here:
// scripts/brief41-undo-miss-delistings.ts reads the rows and passes its Prisma
// client in, and the tests pass fakes.
//
// - Every such row loses the false streetEasyStatus='delisted'.
// - A row the miss made 'stale' gets its processingStatus back by category and
//   date:
//   - 'active' only where a StreetEasy miss means nothing: off-market and
//     coming-soon listings (they aren't on StreetEasy) and buyer or renter
//     requests (they aren't listings);
//   - 'needs_review' for every other category, never 'active': an active sale
//     or rental that left StreetEasy may really have sold or rented, and any
//     other category is left for Ryan too (fail safe). It gets a review-queue
//     item, because /review lists queue items, not statuses;
//   - it stays 'stale' where the sweep's date rules (lib/dateExpiryRules.ts)
//     say so: an open house or showing whose date has passed, a coming soon
//     30+ days past its date.
// - Age alone never keeps a listing hidden: an old off-market or coming-soon
//   listing comes back active whatever its age (the dry run's age column shows
//   them). The sweep's 90-day "needs_review" rule only covers listings
//   StreetEasy never checked, and every old miss wrote a check time, so it
//   never applies to these rows.
// - What Ryan decided stands: a duplicate, or a row he rejected or marked
//   duplicate/stale in review, keeps its status. A row still waiting in the
//   review queue goes to 'needs_review' (no second queue item).
// - A row that isn't 'stale' (already active, in review, rejected) only loses
//   the false flag.
import type { Category, Prisma, PrismaClient } from '@prisma/client'
import { dateExpiryFor } from './dateExpiryRules'

const DAY_MS = 86_400_000

export const SOURCE = 'brief41-undo-miss-delistings'
export const AUDIT_ACTION = 'MISS_DELISTINGS_RESTORED'

// The rows the old lookup delisted on a miss: StreetEasy never gave an id.
// A delisting that came from StreetEasy itself always stored the id.
export const MISSED = { streetEasyStatus: 'delisted', streetEasyId: null } as const

// Where a StreetEasy miss means nothing: these go back to 'active'.
export const RESTORE_TO_ACTIVE: ReadonlySet<string> = new Set([
  'OFF_MARKET_SALE', 'COMING_SOON_SALE', 'COMING_SOON_RENTAL', 'COMING_SOON_DEVELOPMENT',
  'BUYER_ISO', 'RENTER_INQUIRY',
])

export const REVIEW_FLAG = 'streeteasy_not_found'
export const REVIEW_SUGGESTION =
  "StreetEasy didn't find this listing, so it may have sold or rented (or it was never on StreetEasy). " +
  'Approve shows it again; Stale keeps it hidden.'

const DECIDED = new Set(['rejected', 'marked_duplicate', 'marked_stale'])

export interface MissDelistedRow {
  id: string
  rawEmailId: string
  category: string
  isTestData: boolean
  isDuplicate: boolean
  processingStatus: string
  streetEasyStatus: string | null
  streetEasyId: string | null
  streetEasyCheckedAt: Date | null
  availabilityDate: string | null
  createdAt: Date
}

export interface ReviewItemRef {
  opportunityId: string | null
  status: string
}

// active: back to active. needs_review: to the review queue. stays_stale: its
// date has passed. as_decided: Ryan's review decision stands. flag_only: it
// wasn't hidden by the miss.
export type MissOutcome = 'active' | 'needs_review' | 'stays_stale' | 'as_decided' | 'flag_only'

export interface MissRowChange {
  id: string
  rawEmailId: string
  category: string
  isTestData: boolean
  ageDays: number // days since the listing was saved
  outcome: MissOutcome
  oldStreetEasyStatus: string
  oldProcessingStatus: string
  newStreetEasyStatus: null
  newProcessingStatus: string
  addReviewItem: boolean // a pending review-queue item is added (none was waiting)
}

export interface MissRepairPlan {
  changes: MissRowChange[] // every row --apply changes: the count --expect checks
}

function outcomeFor(row: MissDelistedRow, reviewStatuses: string[], now: Date): MissOutcome {
  if (row.isDuplicate || reviewStatuses.some((s) => DECIDED.has(s))) return 'as_decided'
  if (row.processingStatus !== 'stale') return 'flag_only'
  const byDate = dateExpiryFor(row, now)
  if (byDate === 'stale') return 'stays_stale'
  // byDate is never 'needs_review' for a real miss row: that 90-day rule needs
  // streetEasyCheckedAt null, and every old miss wrote it. So the category and
  // the review queue decide, not the listing's age.
  if (byDate === 'needs_review' || !RESTORE_TO_ACTIVE.has(row.category) || reviewStatuses.includes('pending')) return 'needs_review'
  return 'active'
}

export function planMissRepair(rows: MissDelistedRow[], reviewItems: ReviewItemRef[], now: Date): MissRepairPlan {
  const itemsFor = new Map<string, string[]>()
  for (const item of reviewItems) {
    if (!item.opportunityId) continue
    itemsFor.set(item.opportunityId, [...(itemsFor.get(item.opportunityId) ?? []), item.status])
  }
  const changes: MissRowChange[] = []
  for (const row of rows) {
    // Only a miss: a row StreetEasy itself delisted (it has an id) is never touched.
    if (row.streetEasyStatus !== MISSED.streetEasyStatus || row.streetEasyId !== MISSED.streetEasyId) continue
    const statuses = itemsFor.get(row.id) ?? []
    const outcome = outcomeFor(row, statuses, now)
    changes.push({
      id: row.id,
      rawEmailId: row.rawEmailId,
      category: row.category,
      isTestData: row.isTestData,
      ageDays: Math.max(0, Math.floor((now.getTime() - row.createdAt.getTime()) / DAY_MS)),
      outcome,
      oldStreetEasyStatus: row.streetEasyStatus,
      oldProcessingStatus: row.processingStatus,
      newStreetEasyStatus: null,
      newProcessingStatus: outcome === 'active' || outcome === 'needs_review' ? outcome : row.processingStatus,
      addReviewItem: outcome === 'needs_review' && !statuses.includes('pending'),
    })
  }
  return { changes }
}

// ── The dry run's split: category × test data × age ──────────────────────────

export const AGE_BUCKETS: ReadonlyArray<{ label: string; maxDays: number }> = [
  { label: '0-29', maxDays: 29 },
  { label: '30-89', maxDays: 89 },
  { label: '90-179', maxDays: 179 },
  { label: '180+', maxDays: Infinity },
]

export function ageBucket(days: number): string {
  return (AGE_BUCKETS.find((b) => days <= b.maxDays) ?? AGE_BUCKETS[AGE_BUCKETS.length - 1]).label
}

export type SplitRow = {
  category: string
  testData: boolean
  age: string
  rows: number
} & Record<MissOutcome, number>

export function splitMissRepair(plan: MissRepairPlan): SplitRow[] {
  const groups = new Map<string, SplitRow>()
  for (const c of plan.changes) {
    const age = ageBucket(c.ageDays)
    const key = `${c.category}|${c.isTestData}|${age}`
    const g = groups.get(key) ?? { category: c.category, testData: c.isTestData, age, rows: 0, active: 0, needs_review: 0, stays_stale: 0, as_decided: 0, flag_only: 0 }
    g.rows++
    g[c.outcome]++
    groups.set(key, g)
  }
  const ageOrder = (label: string) => AGE_BUCKETS.findIndex((b) => b.label === label)
  return [...groups.values()].sort((a, b) =>
    a.category.localeCompare(b.category) || Number(a.testData) - Number(b.testData) || ageOrder(a.age) - ageOrder(b.age))
}

const COLUMNS: ReadonlyArray<{ title: string; outcome: MissOutcome }> = [
  { title: '-> active', outcome: 'active' },
  { title: '-> review', outcome: 'needs_review' },
  { title: 'stays stale', outcome: 'stays_stale' },
  { title: 'as decided', outcome: 'as_decided' },
  { title: 'flag only', outcome: 'flag_only' },
]

// The table Ryan approves: one line per category, real/test data and age.
// pendingReview: the review queue's pending items now (all of them, as /review
// counts them), so Ryan can see where the new items will land.
export function formatMissRepairTable(plan: MissRepairPlan, opts: { pendingReview?: number } = {}): string {
  const n = plan.changes.length
  if (n === 0) return 'No listings are marked "delisted" by a StreetEasy miss. Nothing to restore.'
  const split = splitMissRepair(plan)
  const count = (o: MissOutcome) => plan.changes.filter((c) => c.outcome === o).length
  const header = ['category', 'data', 'age (days)', 'rows', ...COLUMNS.map((c) => c.title)]
  const body = split.map((g) => [g.category, g.testData ? 'test' : 'real', g.age, String(g.rows), ...COLUMNS.map((c) => String(g[c.outcome]))])
  const total = ['all', '', '', String(n), ...COLUMNS.map((c) => String(count(c.outcome)))]
  const lines = [header, ...body, total]
  const widths = header.map((_, i) => Math.max(...lines.map((l) => l[i].length)))
  const fmt = (l: string[]) => l.map((cell, i) => (i < 3 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ').trimEnd()
  const newItems = plan.changes.filter((c) => c.addReviewItem).length
  return [
    `${n} listing(s) are marked "delisted" only because StreetEasy didn't find them (no StreetEasy id).`,
    'What --apply would do, by category, real or test data, and age (days since the listing was saved):',
    '',
    ...lines.map(fmt),
    '',
    '  -> active    shown again in Drift, search and buyer reports, whatever their age (off-market, coming soon, buyer and renter requests only)',
    `  -> review    to the review queue on /review: Approve shows it again, Stale keeps it hidden. ${newItems} new review item(s); the rest were already waiting`,
    ...(opts.pendingReview === undefined ? [] : [reviewQueueLine(opts.pendingReview, newItems)]),
    '  stays stale  stays hidden: its date has passed (an open house or showing, or a coming soon 30+ days past its date)',
    '  as decided   left as decided in review: a duplicate, or rejected / marked duplicate or stale',
    "  flag only    the miss didn't hide it (already active, in review, or rejected): nothing else changes",
    `Every row loses the false "delisted" flag, so --apply changes ${n} row(s).`,
  ].join('\n')
}

// /review lists pending items 50 at a time, oldest first, so new items land
// behind the current backlog.
export function reviewQueueLine(pending: number, newItems: number): string {
  if (newItems === 0) return `               This run adds no review items (the queue has ${pending} pending now).`
  if (pending === 0) return `               The review queue has no pending items now, so the ${newItems} new one(s) are the first ones on /review.`
  return `               The review queue already has ${pending} pending item(s). /review shows 50 at a time, oldest first, ` +
    `so the ${newItems} new one(s) come after those ${pending}.`
}

// Counts and ids, as the dry run has always printed them.
export function missRepairSummary(plan: MissRepairPlan, opts: { pendingReview?: number } = {}) {
  const ids = (o: MissOutcome) => plan.changes.filter((c) => c.outcome === o).map((c) => c.id)
  const byCategory: Record<string, number> = {}
  for (const c of plan.changes) byCategory[c.category] = (byCategory[c.category] ?? 0) + 1
  return {
    delistedByAMiss: plan.changes.length,
    ofWhichTestData: plan.changes.filter((c) => c.isTestData).length,
    byCategory,
    falseStatusToClear: plan.changes.length,
    backToActive: ids('active').length,
    backToReviewQueue: ids('needs_review').length,
    newReviewItems: plan.changes.filter((c) => c.addReviewItem).length,
    staysStaleByDate: ids('stays_stale').length,
    leftAsDecided: ids('as_decided').length,
    flagOnly: ids('flag_only').length,
    ...(opts.pendingReview === undefined ? {} : { pendingReviewItemsNow: opts.pendingReview }),
    activeIds: ids('active').slice(0, 50),
    reviewIds: ids('needs_review').slice(0, 50),
  }
}

// ── Applying it ──────────────────────────────────────────────────────────────

// One updateMany per (category, old status, new status).
export interface MissRepairWrite {
  category: string
  from: string
  to: string
  ids: string[]
}

export function missRepairWrites(plan: MissRepairPlan): MissRepairWrite[] {
  const groups = new Map<string, MissRepairWrite>()
  for (const c of plan.changes) {
    const key = `${c.category}|${c.oldProcessingStatus}|${c.newProcessingStatus}`
    const w = groups.get(key) ?? { category: c.category, from: c.oldProcessingStatus, to: c.newProcessingStatus, ids: [] }
    w.ids.push(c.id)
    groups.set(key, w)
  }
  return [...groups.values()]
}

// The where-clause repeats everything the plan saw (still a miss: delisted
// with no StreetEasy id, same category and status, same organization), so a
// row that changed since it was read isn't touched.
export function missRepairWhere(w: MissRepairWrite, organizationId: string): Prisma.ExtractedOpportunityWhereInput {
  return { id: { in: w.ids }, organizationId, category: w.category as Category, processingStatus: w.from, ...MISSED }
}

export type MissPreimageRow = {
  id: string
  category: string
  isTestData: boolean
  oldStreetEasyStatus: string
  oldProcessingStatus: string
  newStreetEasyStatus: null
  newProcessingStatus: string
  addReviewItem: boolean
}

export type MissRepairPreimage = {
  what: string
  writtenAt: string
  organizationId: string
  rows: MissPreimageRow[]
}

export function missRepairPreimage(plan: MissRepairPlan, organizationId: string, now: Date): MissRepairPreimage {
  return {
    what: `${SOURCE} pre-image: each listing's values before --apply. To undo a row, set streetEasyStatus and ` +
      `processingStatus back to the old values. Review-queue items this run added have flagReason '${REVIEW_FLAG}'; ` +
      `their ids are in the ${AUDIT_ACTION} AuditLog entry.`,
    writtenAt: now.toISOString(),
    organizationId,
    rows: plan.changes.map((c) => ({
      id: c.id,
      category: c.category,
      isTestData: c.isTestData,
      oldStreetEasyStatus: c.oldStreetEasyStatus,
      oldProcessingStatus: c.oldProcessingStatus,
      newStreetEasyStatus: c.newStreetEasyStatus,
      newProcessingStatus: c.newProcessingStatus,
      addReviewItem: c.addReviewItem,
    })),
  }
}

// A refusal: nothing was changed. The script prints the message and exits 2.
export class MissRepairRefusal extends Error {}

// --expect <n>: the number of rows the approved dry run said --apply changes.
export function parseExpect(argv: readonly string[]): number | null {
  const at = argv.indexOf('--expect')
  if (at < 0) return null
  const value = argv[at + 1] ?? ''
  if (!/^\d+$/.test(value)) throw new MissRepairRefusal(`Refusing: --expect needs a whole number (the dry run's row count), got "${value}". Nothing changed.`)
  return Number(value)
}

export type MissRepairDb = Pick<PrismaClient, '$transaction'>

export interface ApplyMissRepairOptions {
  organizationId: string
  expect: number | null
  now: Date
  // Writes the pre-image to a private file and returns its path. Called
  // before any update; if it throws, nothing is changed.
  writePreimage: (preimage: MissRepairPreimage) => string
  // Where the "written but NOT applied" line goes if the transaction fails
  // (default console.log).
  log?: (line: string) => void
}

export interface ApplyMissRepairResult {
  changed: number
  active: number
  review: number
  reviewItemIds: string[]
  preimageFile: string | null
}

export async function applyMissRepair(db: MissRepairDb, plan: MissRepairPlan, opts: ApplyMissRepairOptions): Promise<ApplyMissRepairResult> {
  const n = plan.changes.length
  if (opts.expect === null) {
    throw new MissRepairRefusal(`Refusing: --apply needs --expect <n>, the row count of the dry run Ryan approved (this run would change ${n}). Nothing changed.`)
  }
  if (opts.expect !== n) {
    throw new MissRepairRefusal(`Refusing: this run would change ${n} row(s), but --expect says ${opts.expect}. Nothing changed. Re-run the dry run and get a new OK on its split.`)
  }
  const count = (o: MissOutcome) => plan.changes.filter((c) => c.outcome === o).length
  if (n === 0) return { changed: 0, active: 0, review: 0, reviewItemIds: [], preimageFile: null }

  const preimage = missRepairPreimage(plan, opts.organizationId, opts.now)
  const preimageFile = opts.writePreimage(preimage)

  const writes = missRepairWrites(plan)
  const newItems = plan.changes.filter((c) => c.addReviewItem)
  const byCategory: Record<string, number> = {}
  for (const c of plan.changes) byCategory[c.category] = (byCategory[c.category] ?? 0) + 1

  // All or nothing: if any row changed since it was read, or the transaction
  // fails for any other reason (a timeout, a dropped connection), it rolls back
  // and nothing is written. The pre-image file stays, so say it wasn't applied.
  let reviewItemIds: string[]
  try {
    reviewItemIds = await db.$transaction(async (tx) => {
      for (const w of writes) {
        const { count: updated } = await tx.extractedOpportunity.updateMany({
          where: missRepairWhere(w, opts.organizationId),
          data: w.to === w.from ? { streetEasyStatus: null } : { streetEasyStatus: null, processingStatus: w.to },
        })
        if (updated !== w.ids.length) {
          throw new MissRepairRefusal(
            `Refusing: ${w.ids.length - updated} ${w.category} listing(s) changed since they were read. ` +
            'Re-run the dry run and get a new OK on its split.')
        }
      }
      const items = newItems.length === 0 ? [] : await tx.reviewQueueItem.createManyAndReturn({
        data: newItems.map((c) => ({
          organizationId: opts.organizationId,
          opportunityId: c.id,
          rawEmailId: c.rawEmailId,
          flagReason: REVIEW_FLAG,
          suggestedAction: REVIEW_SUGGESTION,
          status: 'pending',
        })),
        select: { id: true },
      })
      const ids = items.map((i) => i.id)
      await tx.auditLog.create({
        data: {
          organizationId: opts.organizationId,
          action: AUDIT_ACTION,
          detailsJson: {
            source: SOURCE,
            at: opts.now.toISOString(),
            preimageFile,
            byCategory,
            cleared: n,
            active: count('active'),
            review: count('needs_review'),
            staysStale: count('stays_stale'),
            leftAsDecided: count('as_decided'),
            flagOnly: count('flag_only'),
            newReviewItems: ids.length,
            reviewItemIds: ids,
            rows: preimage.rows,
          },
        },
      })
      return ids
    }, { maxWait: 10_000, timeout: 120_000 })
  } catch (e) {
    (opts.log ?? console.log)(
      `Pre-image written but probably NOT applied: the transaction failed and was rolled back (if it failed while ` +
      `saving, it may have gone through). Re-run the dry run: the same count means nothing changed, none left means ` +
      `it was applied. Pre-image: ${preimageFile}`)
    throw e
  }

  return { changed: n, active: count('active'), review: count('needs_review'), reviewItemIds, preimageFile }
}

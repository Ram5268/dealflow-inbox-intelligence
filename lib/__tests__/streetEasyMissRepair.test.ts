// Brief 41.1 (PR H) — the restore plan for listings an old StreetEasy miss
// marked "delisted": by category and date, the dry run's split, --expect, and
// the pre-image written before any update. Pure: no DB (a stand-in for the
// Prisma client records the calls), no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MissRepairRefusal, REVIEW_FLAG, RESTORE_TO_ACTIVE, ageBucket, applyMissRepair, formatMissRepairTable,
  missRepairSummary, missRepairWhere, missRepairWrites, parseExpect, planMissRepair, splitMissRepair,
  type MissDelistedRow, type MissRepairDb, type MissRepairPreimage,
} from '../streetEasyMissRepair'

const ROOT = join(__dirname, '..', '..')
const NOW = new Date('2026-10-11T12:00:00Z')
const DAY = 86_400_000
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY)
const isoDay = (d: number) => daysAgo(d).toISOString().slice(0, 10) // d days ago; negative = in the future

// A listing the old lookup delisted on a miss: stale, 'delisted', no
// StreetEasy id, checked (the miss wrote the check time), saved 20 days ago.
function row(id: string, over: Partial<MissDelistedRow> = {}): MissDelistedRow {
  return {
    id, rawEmailId: `email-${id}`, category: 'OFF_MARKET_SALE', isTestData: false, isDuplicate: false,
    processingStatus: 'stale', streetEasyStatus: 'delisted', streetEasyId: null,
    streetEasyCheckedAt: daysAgo(10), availabilityDate: null, createdAt: daysAgo(20), ...over,
  }
}
const byId = (plan: ReturnType<typeof planMissRepair>) => Object.fromEntries(plan.changes.map((c) => [c.id, c]))

test('by category: back to active only where a miss means nothing; a sale or rental goes to review, never active', () => {
  const plan = byId(planMissRepair([
    row('off', { category: 'OFF_MARKET_SALE' }),
    row('csSale', { category: 'COMING_SOON_SALE' }),
    row('csRental', { category: 'COMING_SOON_RENTAL' }),
    row('csDev', { category: 'COMING_SOON_DEVELOPMENT' }),
    row('buyer', { category: 'BUYER_ISO' }),
    row('renter', { category: 'RENTER_INQUIRY' }),
    row('sale', { category: 'ACTIVE_SALE_LISTING' }),
    row('rental', { category: 'RENTAL_LISTING' }),
  ], [], NOW))
  for (const id of ['off', 'csSale', 'csRental', 'csDev', 'buyer', 'renter']) {
    assert.equal(plan[id].outcome, 'active', id)
    assert.equal(plan[id].newProcessingStatus, 'active', id)
    assert.equal(plan[id].addReviewItem, false, id)
  }
  // Main's plan put these back to 'active': a sale or rental that left StreetEasy may really have sold.
  for (const id of ['sale', 'rental']) {
    assert.equal(plan[id].outcome, 'needs_review', id)
    assert.equal(plan[id].newProcessingStatus, 'needs_review', id)
    assert.equal(plan[id].addReviewItem, true, id) // so it shows on /review, which lists queue items
  }
  for (const c of Object.values(plan)) assert.equal(c.newStreetEasyStatus, null)
})

test('every other category in the schema is fail safe: to review, never active', () => {
  const schema = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8')
  const categories = /enum Category \{([^}]*)\}/.exec(schema)![1].split(/\s+/).filter(Boolean)
  assert.ok(categories.length >= 20 && categories.includes('SHOWING_CONFIRMATION'))
  for (const c of RESTORE_TO_ACTIVE) assert.ok(categories.includes(c), c)
  const plan = planMissRepair(categories.map((category) => row(category, { category })), [], NOW)
  for (const c of plan.changes) {
    // Undated and 20 days old, so no date rule applies: only the category decides.
    assert.equal(c.outcome, RESTORE_TO_ACTIVE.has(c.category) ? 'active' : 'needs_review', c.category)
  }
  assert.deepEqual(
    plan.changes.filter((c) => c.outcome === 'active').map((c) => c.category).sort(),
    ['BUYER_ISO', 'COMING_SOON_DEVELOPMENT', 'COMING_SOON_RENTAL', 'COMING_SOON_SALE', 'OFF_MARKET_SALE', 'RENTER_INQUIRY'],
  )
})

test('by date: the sweep\'s date rules still apply, so past open houses, showings and coming-soons stay stale', () => {
  const plan = byId(planMissRepair([
    row('csPast', { category: 'COMING_SOON_SALE', availabilityDate: isoDay(45) }),      // 45 days past its date
    row('csRecent', { category: 'COMING_SOON_RENTAL', availabilityDate: isoDay(10) }),  // 10 days past: within the 30
    row('csFuture', { category: 'COMING_SOON_SALE', availabilityDate: isoDay(-30) }),
    row('csDevOld', { category: 'COMING_SOON_DEVELOPMENT', availabilityDate: isoDay(400) }), // the sweep has no date rule for it
    row('ohPast', { category: 'OPEN_HOUSE', availabilityDate: isoDay(3) }),
    row('ohFuture', { category: 'OPEN_HOUSE', availabilityDate: isoDay(-3) }),
    row('showPast', { category: 'SHOWING_CONFIRMATION', availabilityDate: `${isoDay(1)}T14:00` }),
    row('offOldUnchecked', { category: 'OFF_MARKET_SALE', createdAt: daysAgo(120), streetEasyCheckedAt: null }),
    row('offOldChecked', { category: 'OFF_MARKET_SALE', createdAt: daysAgo(120) }),
  ], [], NOW))
  assert.equal(plan.csPast.outcome, 'stays_stale')
  assert.equal(plan.csPast.newProcessingStatus, 'stale')
  assert.equal(plan.csRecent.outcome, 'active')
  assert.equal(plan.csFuture.outcome, 'active')
  assert.equal(plan.csDevOld.outcome, 'active')
  assert.equal(plan.ohPast.outcome, 'stays_stale')
  assert.equal(plan.ohFuture.outcome, 'needs_review') // an upcoming open house is for a listing that may have sold
  assert.equal(plan.showPast.outcome, 'stays_stale')
  // The 90-day rule (old and never checked by StreetEasy) sends it to review, as the sweep would.
  assert.equal(plan.offOldUnchecked.outcome, 'needs_review')
  assert.equal(plan.offOldChecked.outcome, 'active')
  // Every one of them still loses the false flag.
  for (const c of Object.values(plan)) assert.deepEqual([c.oldStreetEasyStatus, c.newStreetEasyStatus], ['delisted', null])
})

test('what Ryan decided in review stands; a row still waiting goes back to the queue', () => {
  const plan = byId(planMissRepair(
    [row('plain'), row('pending'), row('pendingSale', { category: 'ACTIVE_SALE_LISTING' }), row('rejected'), row('dup', { isDuplicate: true }),
      row('approved'), row('reactivated', { processingStatus: 'active' }), row('markedStale'), row('markedDup')],
    [
      { opportunityId: 'pending', status: 'pending' },
      { opportunityId: 'pendingSale', status: 'pending' },
      { opportunityId: 'rejected', status: 'rejected' },
      { opportunityId: 'approved', status: 'approved' },
      { opportunityId: 'markedStale', status: 'marked_stale' },
      { opportunityId: 'markedDup', status: 'marked_duplicate' },
      { opportunityId: null, status: 'pending' },
    ],
    NOW,
  ))
  assert.equal(plan.plain.outcome, 'active')
  assert.equal(plan.approved.outcome, 'active')
  assert.deepEqual([plan.pending.outcome, plan.pending.addReviewItem], ['needs_review', false]) // no second queue item
  assert.deepEqual([plan.pendingSale.outcome, plan.pendingSale.addReviewItem], ['needs_review', false])
  for (const id of ['rejected', 'dup', 'markedStale', 'markedDup']) {
    assert.equal(plan[id].outcome, 'as_decided', id)
    assert.equal(plan[id].newProcessingStatus, 'stale', id)
  }
  assert.deepEqual([plan.reactivated.outcome, plan.reactivated.newProcessingStatus], ['flag_only', 'active'])
})

test('a row with a StreetEasy id or another status is never touched, in the plan or in the database', () => {
  const plan = planMissRepair([
    row('miss'),
    row('realDelisting', { streetEasyId: 'sale/123' }),
    row('sold', { streetEasyStatus: 'sold' }),
    row('alreadyCleared', { streetEasyStatus: null }),
  ], [], NOW)
  assert.deepEqual(plan.changes.map((c) => c.id), ['miss'])
  // Each update repeats the state the plan saw, so a row that changed since (a
  // "Find listing" click stored an id, Ryan reviewed it) isn't touched.
  const writes = missRepairWrites(planMissRepair([row('a'), row('b', { category: 'RENTAL_LISTING' }), row('c', { processingStatus: 'active' })], [], NOW))
  assert.equal(writes.length, 3)
  for (const w of writes) {
    assert.deepEqual(missRepairWhere(w, 'org1'), {
      id: { in: w.ids }, organizationId: 'org1', category: w.category, processingStatus: w.from,
      streetEasyStatus: 'delisted', streetEasyId: null,
    })
  }
})

test('the dry run splits the plan by category x test data x age', () => {
  assert.deepEqual([0, 29, 30, 89, 90, 179, 180, 2000].map(ageBucket), ['0-29', '0-29', '30-89', '30-89', '90-179', '90-179', '180+', '180+'])
  const plan = planMissRepair([
    row('a', { createdAt: daysAgo(5) }),
    row('b', { createdAt: daysAgo(12) }),
    row('c', { createdAt: daysAgo(5), isTestData: true }),
    row('d', { createdAt: daysAgo(200) }),
    row('e', { category: 'ACTIVE_SALE_LISTING', isTestData: true, createdAt: daysAgo(40) }),
    row('f', { category: 'OPEN_HOUSE', isTestData: true, createdAt: daysAgo(40), availabilityDate: isoDay(30) }),
    row('g', { category: 'RENTAL_LISTING', processingStatus: 'active', createdAt: daysAgo(95) }),
    row('h', { category: 'RENTAL_LISTING', createdAt: daysAgo(95) }),
  ], [{ opportunityId: 'e', status: 'pending' }], NOW)
  const zero = { active: 0, needs_review: 0, stays_stale: 0, as_decided: 0, flag_only: 0 }
  assert.deepEqual(splitMissRepair(plan), [
    { category: 'ACTIVE_SALE_LISTING', testData: true, age: '30-89', rows: 1, ...zero, needs_review: 1 },
    { category: 'OFF_MARKET_SALE', testData: false, age: '0-29', rows: 2, ...zero, active: 2 },
    { category: 'OFF_MARKET_SALE', testData: false, age: '180+', rows: 1, ...zero, active: 1 },
    { category: 'OFF_MARKET_SALE', testData: true, age: '0-29', rows: 1, ...zero, active: 1 },
    { category: 'OPEN_HOUSE', testData: true, age: '30-89', rows: 1, ...zero, stays_stale: 1 },
    { category: 'RENTAL_LISTING', testData: false, age: '90-179', rows: 2, ...zero, needs_review: 1, flag_only: 1 },
  ])
  const table = formatMissRepairTable(plan)
  assert.match(table, /^category\s+data\s+age \(days\)\s+rows\s+-> active\s+-> review\s+stays stale\s+as decided\s+flag only$/m)
  assert.match(table, /^OFF_MARKET_SALE\s+real\s+0-29\s+2\s+2\s+0\s+0\s+0\s+0$/m)
  assert.match(table, /^ACTIVE_SALE_LISTING\s+test\s+30-89\s+1\s+0\s+1\s+0\s+0\s+0$/m)
  assert.match(table, /^all\s+8\s+4\s+2\s+1\s+0\s+1$/m)
  assert.match(table, /1 new review item\(s\)/) // 'h'; 'e' was already waiting
  assert.match(table, /--apply changes 8 row\(s\)/)
  const summary = missRepairSummary(plan)
  assert.equal(summary.falseStatusToClear, 8)
  assert.equal(summary.ofWhichTestData, 3)
  assert.deepEqual(summary.reviewIds, ['e', 'h'])
  assert.equal(formatMissRepairTable({ changes: [] }), 'No listings are marked "delisted" by a StreetEasy miss. Nothing to restore.')
})

// ── Applying it, on a stand-in for the Prisma client ─────────────────────────

type UpdateArgs = { where: { id: { in: string[] }; category: string } & Record<string, unknown>; data: Record<string, unknown> }
type ReviewArgs = { data: Array<Record<string, unknown>>; select: { id: true } }
type AuditArgs = { data: { organizationId: string; action: string; detailsJson: Record<string, unknown> } }

// Records every call in order. A category listed in `changedMeanwhile` has
// that many fewer rows matching (they changed since the read). A throw inside
// the transaction rolls back what it wrote.
function fakeDb(changedMeanwhile: Record<string, number> = {}) {
  const log: string[] = []
  const state = { updates: [] as UpdateArgs[], reviewItems: [] as Array<Record<string, unknown>>, audit: [] as AuditArgs['data'][] }
  const tx = {
    extractedOpportunity: {
      updateMany: async (args: UpdateArgs) => {
        log.push('updateMany')
        state.updates.push(args)
        return { count: args.where.id.in.length - (changedMeanwhile[args.where.category] ?? 0) }
      },
    },
    reviewQueueItem: {
      createManyAndReturn: async (args: ReviewArgs) => {
        log.push('reviewQueueItem.createManyAndReturn')
        state.reviewItems.push(...args.data)
        return args.data.map((_, i) => ({ id: `rqi-${i + 1}` }))
      },
    },
    auditLog: {
      create: async (args: AuditArgs) => {
        log.push('auditLog.create')
        state.audit.push(args.data)
        return { id: 'audit-1' }
      },
    },
  }
  const db = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      log.push('$transaction')
      const before = { ...state, updates: [...state.updates], reviewItems: [...state.reviewItems], audit: [...state.audit] }
      try {
        return await fn(tx)
      } catch (e) {
        log.push('rollback')
        Object.assign(state, before)
        throw e
      }
    },
  }
  return { db: db as unknown as MissRepairDb, log, state }
}

const PLAN = planMissRepair([
  row('off'),
  row('sale', { category: 'ACTIVE_SALE_LISTING', isTestData: true }),
  row('oh', { category: 'OPEN_HOUSE', availabilityDate: isoDay(5) }),
], [], NOW)

test('--expect: --apply refuses unless the count matches the approved dry run, before writing anything', async () => {
  assert.equal(parseExpect(['node', 'x.ts', '--apply']), null)
  assert.equal(parseExpect(['node', 'x.ts', '--apply', '--expect', '3']), 3)
  for (const bad of [['--expect'], ['--expect', '--apply'], ['--expect', '-1'], ['--expect', '3.5'], ['--expect', 'three']]) {
    assert.throws(() => parseExpect(bad), MissRepairRefusal, bad.join(' '))
  }
  for (const expect of [null, 0, 2, 4]) {
    const { db, log } = fakeDb()
    let wrote = false
    await assert.rejects(
      applyMissRepair(db, PLAN, { organizationId: 'org1', expect, now: NOW, writePreimage: () => { wrote = true; return '/private/x.json' } }),
      (e: Error) => e instanceof MissRepairRefusal && /Nothing changed/.test(e.message),
    )
    assert.equal(wrote, false, `expect ${expect}`)
    assert.deepEqual(log, [], `expect ${expect}`)
  }
})

test('the pre-image (id, old and new values) is written before any update, and goes in the AuditLog', async () => {
  const { db, log, state } = fakeDb()
  let preimage: MissRepairPreimage | null = null
  const result = await applyMissRepair(db, PLAN, {
    organizationId: 'org1', expect: 3, now: NOW,
    writePreimage: (p) => { log.push('writePreimage'); preimage = p; return '/private/pre.json' },
  })
  assert.equal(log[0], 'writePreimage')
  assert.deepEqual(log, ['writePreimage', '$transaction', 'updateMany', 'updateMany', 'updateMany', 'reviewQueueItem.createManyAndReturn', 'auditLog.create'])
  const rows = (preimage as MissRepairPreimage | null)?.rows ?? []
  assert.deepEqual(rows.find((r) => r.id === 'sale'), {
    id: 'sale', category: 'ACTIVE_SALE_LISTING', isTestData: true,
    oldStreetEasyStatus: 'delisted', oldProcessingStatus: 'stale', newStreetEasyStatus: null, newProcessingStatus: 'needs_review', addReviewItem: true,
  })
  assert.deepEqual(rows.map((r) => [r.id, r.newProcessingStatus]), [['off', 'active'], ['sale', 'needs_review'], ['oh', 'stale']])
  // Each update re-checks the state the plan saw, and never sets 'active' on a sale.
  for (const u of state.updates) assert.deepEqual([u.where.streetEasyStatus, u.where.streetEasyId, u.where.organizationId], ['delisted', null, 'org1'])
  const toActive = state.updates.filter((u) => u.data.processingStatus === 'active').flatMap((u) => u.where.id.in)
  assert.deepEqual(toActive, ['off'])
  assert.deepEqual(state.updates.find((u) => u.where.id.in.includes('oh'))?.data, { streetEasyStatus: null }) // stays stale
  // The review item, so the sale shows on /review.
  assert.deepEqual(state.reviewItems, [{
    organizationId: 'org1', opportunityId: 'sale', rawEmailId: 'email-sale', flagReason: REVIEW_FLAG,
    suggestedAction: state.reviewItems[0].suggestedAction, status: 'pending',
  }])
  // The AuditLog entry carries the same pre-image and the new review item ids.
  const audit = state.audit[0]
  assert.equal(audit.action, 'MISS_DELISTINGS_RESTORED')
  assert.deepEqual(audit.detailsJson.rows, rows)
  assert.deepEqual(audit.detailsJson.reviewItemIds, ['rqi-1'])
  assert.equal(audit.detailsJson.preimageFile, '/private/pre.json')
  assert.deepEqual(result, { changed: 3, active: 1, review: 1, reviewItemIds: ['rqi-1'], preimageFile: '/private/pre.json' })
})

test('if the pre-image can\'t be written, nothing is updated', async () => {
  const { db, log } = fakeDb()
  await assert.rejects(
    applyMissRepair(db, PLAN, { organizationId: 'org1', expect: 3, now: NOW, writePreimage: () => { throw new Error('EACCES') } }),
    /EACCES/,
  )
  assert.deepEqual(log, [])
})

test('a row that changed since the read rolls the whole run back', async () => {
  const { db, log, state } = fakeDb({ ACTIVE_SALE_LISTING: 1 })
  await assert.rejects(
    applyMissRepair(db, PLAN, { organizationId: 'org1', expect: 3, now: NOW, writePreimage: () => '/private/pre.json' }),
    (e: Error) => e instanceof MissRepairRefusal && /changed since they were read/.test(e.message),
  )
  assert.equal(log.at(-1), 'rollback')
  assert.ok(!log.includes('auditLog.create'))
  assert.deepEqual([state.updates.length, state.reviewItems.length, state.audit.length], [0, 0, 0])
})

test('an empty plan changes nothing and writes no file', async () => {
  const { db, log } = fakeDb()
  const empty = planMissRepair([], [], NOW)
  const result = await applyMissRepair(db, empty, { organizationId: 'org1', expect: 0, now: NOW, writePreimage: () => { throw new Error('not called') } })
  assert.deepEqual(result, { changed: 0, active: 0, review: 0, reviewItemIds: [], preimageFile: null })
  assert.deepEqual(log, [])
})

// Brief 48 (PR 15, item 4.13): the StreetEasy sweep's 90-day rule. A sale, rental,
// off-market, back-on-market or price-drop listing over 90 days old that StreetEasy
// never checked goes to 'needs_review'. The sweep set that status but never added a
// Review Queue item, and /review lists items, not statuses, so the listing dropped
// out of search and matching with nothing asking Ryan about it. Now:
// - each such listing gets one pending item, written in the same transaction as the
//   status (the pattern of lib/streetEasyMissRepair.ts);
// - a listing with a pending item already gets no second one;
// - Ryan answers once: a listing whose 90-day item he already decided is left alone,
//   so approving it (which makes it active again) doesn't bring it back every day.
// Runs the real sweepDateExpirations on an in-memory stand-in for Prisma; fetch
// throws, so a change that added a network call would fail here. Every row is invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listingDb, type Row } from '../extraction/__tests__/listingDb'
import { AGED_REVIEW_FLAG } from '../dateExpiryRules'

process.env.STREETEASY_SYNC_ENABLED = 'true'
delete process.env.TEST_MODE_ONLY
globalThis.fetch = (async () => { throw new Error('no network in this test') }) as typeof fetch

let db = listingDb({})
;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy({}, { get: (_t, prop) => (db.client as Record<string | symbol, unknown>)[prop] })

const day = (d: number) => new Date(Date.now() - d * 86_400_000)
const listing = (id: string, over: Row = {}): Row => ({
  id, organizationId: 'org-test', rawEmailId: `raw-${id}`, category: 'ACTIVE_SALE_LISTING', processingStatus: 'active',
  availabilityDate: null, streetEasyCheckedAt: null, createdAt: day(120), ...over,
})
const item = (opportunityId: string, status: string, flagReason = AGED_REVIEW_FLAG): Row => ({
  id: `item-${opportunityId}`, organizationId: 'org-test', opportunityId, rawEmailId: `raw-${opportunityId}`, flagReason, status, createdAt: day(30),
})
function seed() {
  db = listingDb({
    extractedOpportunity: [
      listing('aged'),
      listing('agedOff', { category: 'OFF_MARKET_SALE', createdAt: day(91) }),
      listing('agedPending'), // already waiting in the queue for another reason
      listing('agedApproved'), // Ryan approved its 90-day item: active again, still never checked
      listing('young', { createdAt: day(80) }),
      listing('checked', { streetEasyCheckedAt: day(10) }),
      listing('buyer', { category: 'BUYER_ISO' }),
    ],
    reviewQueueItem: [item('agedPending', 'pending', 'low_confidence'), item('agedApproved', 'approved')],
  })
}
const status = (id: string) => db.rows('extractedOpportunity').find(r => r.id === id)?.processingStatus
const newItems = () => db.rows('reviewQueueItem').filter(r => !String(r.id).startsWith('item-'))

test('a 90-day listing goes to needs_review with a pending Review Queue item, in one transaction', async () => {
  seed()
  const { sweepDateExpirations } = await import('../streetEasySync')
  const count = await sweepDateExpirations()
  assert.deepEqual(['aged', 'agedOff', 'agedPending'].map(status), ['needs_review', 'needs_review', 'needs_review'])
  assert.deepEqual(['agedApproved', 'young', 'checked', 'buyer'].map(status), ['active', 'active', 'active', 'active'])
  assert.equal(count, 3)
  const items = newItems()
  assert.deepEqual(items.map(i => i.opportunityId).sort(), ['aged', 'agedOff'], 'one item each; agedPending already has one')
  for (const i of items) {
    assert.equal(i.flagReason, AGED_REVIEW_FLAG)
    assert.equal(i.status, 'pending')
    assert.equal(i.organizationId, 'org-test')
    assert.equal(i.rawEmailId, `raw-${i.opportunityId}`)
    assert.ok(typeof i.suggestedAction === 'string' && (i.suggestedAction as string).length > 0)
  }
  const aged = ['aged', 'agedOff', 'agedPending']
  const writes = db.calls.filter(c =>
    (c.model === 'extractedOpportunity' && c.op === 'update' && aged.includes((c.args.where as Row).id as string)) ||
    (c.model === 'reviewQueueItem' && c.op === 'create'))
  assert.equal(writes.length, 5, '3 status updates and 2 items')
  for (const c of writes) assert.ok(c.inTx, `${c.model}.${c.op} runs inside a transaction`)
})

test('running the sweep again adds nothing, and an approved listing is not asked about again', async () => {
  seed()
  const { sweepDateExpirations } = await import('../streetEasySync')
  await sweepDateExpirations()
  const after = newItems().length
  // Ryan approves the new items: the listings are active again, still never checked.
  for (const i of newItems()) {
    i.status = 'approved'
    db.rows('extractedOpportunity').find(r => r.id === i.opportunityId)!.processingStatus = 'active'
  }
  assert.equal(await sweepDateExpirations(), 0)
  assert.equal(newItems().length, after)
  assert.deepEqual(['aged', 'agedOff', 'agedApproved'].map(status), ['active', 'active', 'active'])
})

test('the Review Queue page shows the 90-day item with a plain label', () => {
  const page = readFileSync(join(__dirname, '..', '..', 'app', 'review', 'page.tsx'), 'utf8')
  assert.match(page, new RegExp(`${AGED_REVIEW_FLAG}:\\s+'Over 90 days old'`))
})

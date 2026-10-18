// Brief 44 (PR 4): the pure parts of scripts/valuation-switch-preview.ts. The call
// list it builds in memory must rank exactly as buildCallQueue ranks the same
// matches once they are saved, and its report holds counts only. Runs under tsx
// (buildCallQueue imports lib/prisma, so a stand-in is installed first). No
// database; every contact is invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rankInMemory, compareTop, tierCounts, previewReport, type QueueContact } from '../ourEstimatesPreview'
import { rollbackCheck } from '../ourEstimates'
import type { Candidate } from '../nightly/select'

const now = new Date() // buildCallQueue ranks against the wall clock
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000)
const qc = (id: string, over: Partial<QueueContact> = {}): QueueContact => ({
  id, phone: '+1 212-555-0123', additionalPhones: [], phoneDncFlags: [false], phoneTypes: ['mobile'],
  lastCalled: null, lastDialDate: null, status: null, preForeclosureStatus: null, isVacant: null,
  tags: [], groups: [], ...over,
})
const cand = (sellerId: string, buyerId: string, fit: number, over: Partial<Candidate> = {}): Candidate => ({
  sellerId, buyerId, counterpartType: 'opportunity', captureStatus: 'EXTERNAL_BOTH',
  matchFit: { matchFit: fit, matchFitConfidence: fit > 90 ? 'HIGH' : 'MEDIUM', contributions: { neighborhood: 40, beds: 30, price: 30 }, unknownFactors: [] },
  ...over,
})

const CONTACTS = [
  qc('c1'),
  qc('c2', { lastCalled: daysAgo(2) }),
  qc('c3', { status: 'Do Not Call' }), // excluded
  qc('c4', { phone: '+1 212-555-0124', phoneDncFlags: [true] }), // every phone on the do-not-call list: excluded
  qc('c5', { preForeclosureStatus: 'LIS_PENDENS', isVacant: true }),
  qc('c6'), // no matches: excluded
  qc('c7', { phone: null, phoneDncFlags: [] }),
  qc('c8', { lastDialDate: daysAgo(40) }),
]
const KEPT = [
  cand('c1', 'b1', 95), cand('c1', 'b2', 80),
  cand('c2', 'b1', 97, { captureStatus: 'OWN_LISTING_ONLY' }),
  cand('c3', 'b1', 99), cand('c4', 'b2', 88),
  cand('c5', 'b3', 70), cand('c5', 'b2', 70),
  cand('c7', 'b1', 82), cand('c8', 'b3', 91), cand('c8', 'b1', 64),
]
const created = (c: Candidate) => (c.sellerId === 'c8' ? daysAgo(20) : c.buyerId === 'b2' ? daysAgo(5) : now)

test("the in-memory call list ranks exactly as buildCallQueue ranks the same matches once saved", async () => {
  const rows = KEPT.map((c, i) => ({
    id: `m${i}`, score: c.matchFit.matchFit, matchFitConfidence: c.matchFit.matchFitConfidence, captureStatus: c.captureStatus,
    createdAt: created(c), contributions: c.matchFit.contributions, opportunityId: c.sellerId, opportunityType: 'contact',
    counterpartId: c.buyerId, counterpartType: c.counterpartType,
  }))
  ;(globalThis as unknown as { prisma: unknown }).prisma = {
    mojoContact: { findMany: async () => CONTACTS.map(c => ({ ...c, fullName: 'Test Homeowner', neighborhood: 'Park Slope' })) },
    match: { findMany: async () => rows },
    matchDismissal: { findMany: async () => [] },
    extractedOpportunity: { findMany: async () => [] },
  }
  const { buildCallQueue } = await import('../../ranking/queueBuilder')
  const saved = await buildCallQueue('org-test', Infinity, false, { scope: 'crm' })
  const inMemory = rankInMemory(CONTACTS, KEPT, created, new Date())
  assert.deepEqual(inMemory, saved.entries.map(e => ({ contactId: e.contactId, priorityScore: e.priorityScore })))
  assert.deepEqual(inMemory.map(r => r.contactId).sort(), ['c1', 'c2', 'c5', 'c7', 'c8'])
})

test('top 50: how many leave it, and the rank correlation of its sellers', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `s${i}`)
  assert.deepEqual(compareTop(ids, ids), { leaving: 0, spearman: 1 })
  const reversedTop = [...ids.slice(0, 50).reverse(), ...ids.slice(50)]
  assert.deepEqual(compareTop(ids, reversedTop), { leaving: 0, spearman: -1 })
  // Two sellers drop to the bottom; two from below move in.
  const moved = [...ids.slice(2, 52), ...ids.slice(52), 's0', 's1']
  const r = compareTop(ids, moved)
  assert.equal(r.leaving, 2)
  assert.equal(r.spearman, 0.77) // 1 - 6 x 4,800 / (50 x 2,499)
  // A seller that leaves the list entirely counts as last.
  assert.equal(compareTop(['a', 'b', 'c'], ['b', 'c'], 50).leaving, 1)
  assert.equal(compareTop([], []).spearman, null)
})

test('tier counts', () => {
  assert.deepEqual(tierCounts(KEPT), { HOT: 7, WARM: 2, POSSIBLE: 1 })
  assert.deepEqual(tierCounts([]), { HOT: 0, WARM: 0, POSSIBLE: 0 })
})

test('the preview report holds counts only', () => {
  const withOurs = KEPT.filter(c => c.sellerId !== 'c8')
  const report = previewReport({
    includeTestBuyers: true, switchOn: false, sellers: 8, buyers: 3, sellersPricedByOurValue: 6,
    without: { kept: KEPT, ineligibleByReason: { wrong_price: 4, wrong_beds: 2 } },
    withOurs: { kept: withOurs, ineligibleByReason: { wrong_price: 9 } },
    listWithout: rankInMemory(CONTACTS, KEPT, created, now),
    listWith: rankInMemory(CONTACTS, withOurs, created, now),
    check: rollbackCheck(KEPT, withOurs, 6),
  })
  assert.deepEqual(report.withoutOurValues, { matches: 10, tiers: { HOT: 7, WARM: 2, POSSIBLE: 1 }, sellersCovered: 7, wrongPrice: 4, callList: 5 })
  assert.deepEqual(report.withOurValues, { matches: 8, tiers: { HOT: 6, WARM: 2, POSSIBLE: 0 }, sellersCovered: 6, wrongPrice: 9, callList: 4 })
  assert.equal(report.top50.leaving, 1)
  const codes = new Set(['error', 'hot_halved', 'sellers_lost_matches'])
  const walk = (v: unknown, path: string): void => {
    if (v && typeof v === 'object') return Object.entries(v).forEach(([k, x]) => walk(x, `${path}.${k}`))
    assert.ok(typeof v === 'number' || typeof v === 'boolean' || v === null || codes.has(v as string), `${path}: ${String(v)}`)
  }
  walk(report, 'report')
})

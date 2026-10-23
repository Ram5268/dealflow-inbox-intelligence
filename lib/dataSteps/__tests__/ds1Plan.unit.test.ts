// Brief 48 DS-1: the plan for removing the duplicate spreadsheet copies, from
// made-up facts (no DB): which duplicates are refused, what moves to the kept
// record and what is removed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REFUSAL_REASONS, ds1Blockers, ds1Summary, ds1Writes, planDs1, type Ds1Facts } from '../ds1Duplicates'

const ORG = 'org-ryan'
const dup = (id: string, duplicateOf: string | null, over: Partial<Ds1Facts['duplicates'][number]> = {}) => ({
  id, mojoId: `csv_${id}`, organizationId: ORG, isTestData: false, duplicateOf, hasCrmLeadId: false, ...over,
})
const keeper = (id: string, over: Partial<Ds1Facts['keepers'][number]> = {}) => ({
  id, organizationId: ORG, isTestData: false, source: 'crm', hash: `h-${id}`, ...over,
})
function facts(over: Partial<Ds1Facts> = {}): Ds1Facts {
  return {
    orgId: ORG, duplicates: [dup('d1', 'k1'), dup('d2', 'k1'), dup('d3', 'k2')], keepers: [keeper('k1'), keeper('k2')],
    sellerMatches: [], buyerMatches: [], otherTypeMatches: 0, dismissals: [], queueOfDuplicates: [], queueNamingRemoved: [],
    callLogs: [], callLogsOnRemovedQueueRows: 0, instantly: [], otherForeignKeys: {}, feedback: [], exactMentions: {}, ...over,
  }
}

test('every duplicate maps to its kept record; nothing to refuse', () => {
  const p = planDs1(facts())
  assert.deepEqual(p.duplicates, ['d1', 'd2', 'd3'])
  assert.deepEqual(p.keeperOf, { d1: 'k1', d2: 'k1', d3: 'k2' })
  assert.deepEqual(p.refusals, {})
  assert.equal(ds1Writes(p), 3)
})

test('refused: duplicateOf missing, pointing at no row, another organization, a test row, itself or another duplicate; not a csv copy; a CRM lead id', () => {
  const p = planDs1(facts({
    duplicates: [
      dup('a', null), dup('b', 'nobody'), dup('c', 'kOther'), dup('d', 'kTest'), dup('e', 'e'), dup('f', 'd1'),
      dup('g', 'k1', { mojoId: 'mojo-123' }), dup('h', 'k1', { hasCrmLeadId: true }), dup('d1', 'k1'),
    ],
    keepers: [keeper('k1'), keeper('kOther', { organizationId: 'org-other' }), keeper('kTest', { isTestData: true }), keeper('d1', { source: 'duplicate' })],
  }))
  assert.deepEqual(p.refusals[REFUSAL_REASONS.noDuplicateOf], ['a'])
  assert.deepEqual(p.refusals[REFUSAL_REASONS.keeperNotFound], ['b'])
  assert.deepEqual(p.refusals[REFUSAL_REASONS.keeperOtherOrg], ['c'])
  assert.deepEqual(p.refusals[REFUSAL_REASONS.keeperIsTest], ['d'])
  assert.deepEqual(p.refusals[REFUSAL_REASONS.pointsAtItself], ['e'])
  assert.deepEqual(p.refusals[REFUSAL_REASONS.keeperIsDuplicate], ['f'])
  assert.deepEqual(p.refusals[REFUSAL_REASONS.notCsvCopy], ['g'])
  assert.deepEqual(p.refusals[REFUSAL_REASONS.carriesCrmLeadId], ['h'])
  const summary = ds1Summary(p, facts(), {})
  assert.equal(summary.refusals[REFUSAL_REASONS.noDuplicateOf], 1)
})

test("other organizations' and test duplicates are left alone, only counted", () => {
  const p = planDs1(facts({ duplicates: [dup('d1', 'k1'), dup('x', 'k9', { organizationId: 'org-demo' }), dup('t', 'k1', { isTestData: true })] }))
  assert.deepEqual(p.duplicates, ['d1'])
  assert.deepEqual(p.outOfScope, { otherOrganizations: 1, testData: 1 })
  assert.deepEqual(p.refusals, {}) // the other org's duplicate points at a row not loaded: not ours to judge
})

test("matches on a duplicate (either side) are removed; the call list drops their ids; the duplicates' own list rows go", () => {
  const p = planDs1(facts({
    sellerMatches: [{ id: 'm1', opportunityId: 'd1' }],
    buyerMatches: [{ id: 'm2', counterpartId: 'd2' }, { id: 'm1', counterpartId: 'd2' }],
    queueOfDuplicates: [{ id: 'q2' }],
    queueNamingRemoved: [
      { id: 'q1', primaryMatchId: 'm1', contributingMatchIds: ['m3', 'm2'] },
      { id: 'q3', primaryMatchId: 'm3', contributingMatchIds: ['m2'] },
      { id: 'q2', primaryMatchId: 'm1', contributingMatchIds: [] }, // a duplicate's own row: removed, not rewritten
    ],
  }))
  assert.deepEqual(p.removeMatches, ['m1', 'm2'])
  assert.deepEqual(p.removeQueue, ['q2'])
  assert.deepEqual(p.changeQueue, [
    { id: 'q1', from: { primaryMatchId: 'm1', contributingMatchIds: ['m3', 'm2'] }, to: { primaryMatchId: null, contributingMatchIds: ['m3'] } },
    { id: 'q3', from: { primaryMatchId: 'm3', contributingMatchIds: ['m2'] }, to: { primaryMatchId: 'm3', contributingMatchIds: [] } },
  ])
})

test("dismissals move to the kept record; the earliest wins a shared pair; the kept record's own stay; collisions go", () => {
  const p = planDs1(facts({
    dismissals: [
      { id: 'dK', partyId: 'b1', listingId: 'k1', dismissedAt: '2026-09-01T00:00:00.000Z' }, // the kept record's own
      { id: 'dS1', partyId: 'b1', listingId: 'd1', dismissedAt: '2026-09-02T00:00:00.000Z' }, // collides with dK
      { id: 'dS3', partyId: 'b2', listingId: 'd2', dismissedAt: '2026-09-04T00:00:00.000Z' }, // later twin of dS2
      { id: 'dS2', partyId: 'b2', listingId: 'd1', dismissedAt: '2026-09-03T00:00:00.000Z' },
      { id: 'dS4', partyId: 'b1', listingId: 'd3', dismissedAt: '2026-09-05T00:00:00.000Z' },
      { id: 'dSelf', partyId: 'd1', listingId: 'k1', dismissedAt: '2026-09-06T00:00:00.000Z' }, // would pair k1 with itself
    ],
  }))
  assert.deepEqual(p.removeDismissals, ['dS1', 'dS3', 'dSelf'])
  assert.deepEqual(p.changeDismissals, [
    { id: 'dS2', from: { partyId: 'b2', listingId: 'd1' }, to: { partyId: 'b2', listingId: 'k1' } },
    { id: 'dS4', from: { partyId: 'b1', listingId: 'd3' }, to: { partyId: 'b1', listingId: 'k2' } },
  ])
})

test('call history, email events and feedback move to the kept record', () => {
  const p = planDs1(facts({
    sellerMatches: [{ id: 'm1', opportunityId: 'd1' }],
    callLogs: [{ id: 'l1', contactId: 'd1' }],
    instantly: [{ id: 'i1', contactId: 'd3' }],
    feedback: [{ id: 'f1', opportunityId: 'd1', matchId: 'm1' }, { id: 'f2', opportunityId: 'o9', matchId: 'm1' }],
  }))
  assert.deepEqual(p.changeCallLogs, [{ id: 'l1', from: { contactId: 'd1' }, to: { contactId: 'k1' } }])
  assert.deepEqual(p.changeInstantly, [{ id: 'i1', from: { contactId: 'd3' }, to: { contactId: 'k2' } }])
  assert.deepEqual(p.changeFeedback, [
    { id: 'f1', from: { opportunityId: 'd1', matchId: 'm1' }, to: { opportunityId: 'k1', matchId: null } },
    { id: 'f2', from: { opportunityId: 'o9', matchId: 'm1' }, to: { opportunityId: 'o9', matchId: null } },
  ])
  assert.equal(ds1Writes(p), 3 + 1 + 1 + 1 + 2)
})

test('the summary is counts only, and --expect is the number of duplicates', () => {
  const f = facts({ sellerMatches: [{ id: 'm1', opportunityId: 'd1' }] })
  const s = ds1Summary(planDs1(f), f, { 'AuditLog (log entries)': 2 })
  assert.equal(s.expect, 3)
  assert.equal(s.duplicates.toRemove, 3)
  assert.equal(s.duplicates.keptRecords, 2)
  assert.equal(s.rowsWritten, 4)
  assert.doesNotMatch(JSON.stringify(s), /csv_[a-z0-9]|"(d|k)\d"/i) // no spreadsheet keys or row ids in the summary
})

test("a row of any other table with a foreign key to a duplicate (found in the catalog) blocks the run", () => {
  assert.deepEqual(ds1Blockers(facts({ otherForeignKeys: { '"SomeTable"."contactId"': 0 } })), [])
  const b = ds1Blockers(facts({ otherForeignKeys: { '"SomeTable"."contactId"': 2, '"Other"."ownerId"': 0 } }))
  assert.equal(b.length, 1)
  assert.match(b[0], /2 row\(s\) of "SomeTable"\."contactId" point at a duplicate/)
})

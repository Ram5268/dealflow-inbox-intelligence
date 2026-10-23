// Brief 48 review (data steps): restoring DS-2 after the nightly has used the
// new test buyers. Deleting the buyers alone would leave their matches, the call
// list naming those matches, and dismissals or feedback about them pointing at
// buyers that no longer exist. Made-up rows, no DB.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyBeforeCopy, type BeforeCopy } from '../common'
import { planRestore, type RestoreFacts } from '../restore'

const B1 = 'test48-buyer-opp-001'
const B2 = 'test48-buyer-opp-002'
const key = { organizationId: 'org-1', category: 'BUYER_ISO', isTestData: true, rawEmailId: 'raw-anchor' }

function copy(): BeforeCopy {
  const c = emptyBeforeCopy('DS-2', 'b48_x_test', 'org-1', new Date('2026-10-23T12:00:00Z'))
  c.created = { ExtractedOpportunity: [{ id: B1, ...key, extractedTitle: '[TEST_48] a' }, { id: B2, ...key, extractedTitle: '[TEST_48] b' }] }
  return c
}
const current = { ExtractedOpportunity: [{ id: B1, ...key, extractedTitle: '[TEST_48] a' }, { id: B2, ...key, extractedTitle: '[TEST_48] b' }] }

test('before any nightly: only the created buyers are deleted', () => {
  const p = planRestore(copy(), { current, generationsNow: [], uniqueTaken: {}, reportsOnCreated: 0 })
  assert.deepEqual(p.refusals, {})
  assert.deepEqual(p.remove, [{ table: 'ExtractedOpportunity', ids: [B1, B2] }])
  assert.equal(p.writes, 2)
})

test('after the nightly: the buyers\' matches, their ids on the call list, dismissals and feedback go with them', () => {
  const facts: RestoreFacts = {
    current, generationsNow: ['gen-2'], uniqueTaken: {}, reportsOnCreated: 0,
    derived: {
      matches: ['nm1', 'nm2'],
      queue: [{ id: 'q1', primaryMatchId: 'nm1', contributingMatchIds: ['k7', 'nm2'] }],
      dismissals: ['dn1'],
      feedback: [{ id: 'f1', opportunityId: B1, matchId: 'nm1' }],
    },
  }
  const p = planRestore(copy(), facts)
  assert.deepEqual(p.refusals, {})
  assert.deepEqual(p.remove.map(r => [r.table, r.ids]), [['ExtractedOpportunity', [B1, B2]], ['Match', ['nm1', 'nm2']], ['MatchDismissal', ['dn1']]])
  assert.deepEqual(p.revert, [
    { table: 'CallQueueEntry', changes: [{ id: 'q1', from: { primaryMatchId: 'nm1', contributingMatchIds: ['k7', 'nm2'] }, to: { primaryMatchId: null, contributingMatchIds: ['k7'] } }] },
    { table: 'OutcomeFeedback', changes: [{ id: 'f1', from: { opportunityId: B1, matchId: 'nm1' }, to: { opportunityId: null, matchId: null } }] },
  ])
  assert.equal(p.writes, 2 + 2 + 1 + 1 + 1) // all of it counted for --expect
})

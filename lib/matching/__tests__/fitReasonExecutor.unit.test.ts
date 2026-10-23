// Brief 48 PR 13 (4.16; Brief 46 M5): "executor" (of an estate) wasn't on the
// list of seller circumstances, so a stored fit line naming one reached a buyer,
// and a draft naming one passed Drift's draft check. It is on the list now
// (with "executrix"); "execute" and "executive" aren't. Pure.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GENERIC_FIT_REASON, SELLER_CIRCUMSTANCES, plainFitReason } from '../fitReason'
import { checkDraft } from '../../chat/guards/draftPrivacy'

test('a stored fit line naming an executor becomes the plain line', () => {
  assert.equal(plainFitReason('Executor wants a quick sale, fits the budget'), GENERIC_FIT_REASON)
  assert.equal(plainFitReason('Being sold by the executrix of the owner'), GENERIC_FIT_REASON)
  assert.equal(plainFitReason('Two executors are handling the sale'), GENERIC_FIT_REASON)
})

test('"execute" and "executive" are not seller circumstances', () => {
  for (const ok of ['Ready to execute a contract quickly', 'Executive-level finishes, right neighborhood']) {
    assert.equal(SELLER_CIRCUMSTANCES.test(ok), false, ok)
    assert.equal(plainFitReason(ok), ok)
  }
})

test("Drift's draft check flags an executor in a note to a buyer's agent", () => {
  const draft = { channel: 'email' as const, audience: 'buyer_side' as const,
    body: 'Hi,\n\nThe executor may sell a 3-family in Bed-Stuy. Price on request.\n\nBest,\nRyan Martin' }
  const r = checkDraft(draft, { homeowners: [], typedAddresses: [], listingAddresses: [], listingPrices: [] })
  assert.ok(r.flags.some(f => f.kind === 'seller_circumstance'), JSON.stringify(r.flags))
})

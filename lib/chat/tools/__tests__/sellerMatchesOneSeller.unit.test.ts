import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFakePrisma, contact, match, isoBuyer, ORG_ROW } from '../../__tests__/pr6Fixtures'

// Brief 43 PR 6 review (D11 [Ryan, 2026-10-18]): one named seller per message,
// across find_seller and get_seller_matches [engineering precaution]. The same
// seller's contact and buyers in one message is fine; a second seller is a
// name and neighborhood with a note, never a card. Fictional names only.
const fake = makeFakePrisma({
  organization: [ORG_ROW], matchDismissal: [], callQueueEntry: [],
  extractedOpportunity: [isoBuyer({ id: 'iso_1' })],
  mojoContact: [
    contact({ id: 'mc_pat', fullName: 'Pat Example', address: '88 Example Ave' }),
    contact({ id: 'mc_jordan', fullName: 'Jordan Sample', address: '12 Sample St' }),
  ],
  match: [
    match({ id: 'm_pat', opportunityId: 'mc_pat', counterpartId: 'iso_1', score: 90, tier: 'HOT' }),
    match({ id: 'm_jordan', opportunityId: 'mc_jordan', counterpartId: 'iso_1', score: 80, tier: 'HOT' }),
  ],
})
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

test('the same seller: contact card and matches card in one message', async () => {
  const { runCrmSellerTool, newCrmSellerTurn } = await import('../crmSellerTools')
  const turn = newCrmSellerTurn()
  const contactRun = await runCrmSellerTool('find_seller', { name: 'Pat Example' }, turn)
  const matchesRun = await runCrmSellerTool('get_seller_matches', { address: '88 Example Ave' }, turn)
  assert.equal(contactRun.card?.id, 'mc_pat')
  assert.equal(matchesRun.matchesCard?.seller.id, 'mc_pat')
})

test('a second seller in the same message: no matches card, no address, a note', async () => {
  const { runCrmSellerTool, newCrmSellerTurn, ONE_SELLER_PER_MESSAGE } = await import('../crmSellerTools')
  const turn = newCrmSellerTurn()
  await runCrmSellerTool('find_seller', { name: 'Pat Example' }, turn)
  const second = await runCrmSellerTool('get_seller_matches', { name: 'Jordan Sample' }, turn)
  assert.equal(second.matchesCard, null)
  assert.deepEqual(second.forModel, { candidates: [{ kind: 'crm_seller', id: 'mc_jordan', name: 'Jordan Sample', neighborhood: 'Bedford-Stuyvesant' }], note: ONE_SELLER_PER_MESSAGE })
  assert.ok(!JSON.stringify(second.output).includes('12 Sample St'))
  // and the other way round: buyers first, then another seller's contact
  const turn2 = newCrmSellerTurn()
  await runCrmSellerTool('get_seller_matches', { name: 'Jordan Sample' }, turn2)
  const contactRun = await runCrmSellerTool('find_seller', { name: 'Pat Example' }, turn2)
  assert.equal(contactRun.card, null)
})

test('parallel calls for two sellers: exactly one gets a card', async () => {
  const { runCrmSellerTool, newCrmSellerTurn } = await import('../crmSellerTools')
  const turn = newCrmSellerTurn()
  const runs = await Promise.all([
    runCrmSellerTool('get_seller_matches', { name: 'Pat Example' }, turn),
    runCrmSellerTool('get_seller_matches', { name: 'Jordan Sample' }, turn),
  ])
  assert.equal(runs.filter(r => r.matchesCard).length, 1)
  // A new message starts a new turn.
  const next = await runCrmSellerTool('get_seller_matches', { name: 'Jordan Sample' }, newCrmSellerTurn())
  assert.equal(next.matchesCard?.seller.id, 'mc_jordan')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFakePrisma, contact, ORG, ORG_ROW, type Row } from '../../__tests__/pr5FakePrisma'

// Brief 43 PR 5 review (D11 [Ryan, 2026-10-18]: only a seller Ryan names):
// a name lookup must not be a search. Substrings ("Ann" inside "Joanne") and
// LIKE wildcards (Prisma 7 sends contains/startsWith/insensitive equals to
// Postgres as ILIKE without escaping % and _) would hand Ryan the contact of a
// seller he never named; and one turn gives at most one contact
// [engineering precaution]. Pure: fake Prisma; fictional names.
const fake = makeFakePrisma({ organization: [ORG_ROW], mojoContact: [] })
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma
const reset = (rows: Row[]) => { fake.tables.mojoContact = rows; fake.calls.length = 0 }

const people = () => [
  contact({ id: 'mc_joanne', fullName: 'Joanne Probe' }),
  contact({ id: 'mc_jackson', fullName: 'Lee Jackson' }),
  contact({ id: 'mc_abby', fullName: 'Abby Mcdermott' }),
  contact({ id: 'mc_ann', fullName: 'Ann Sample' }),
  contact({ id: 'mc_rev', fullName: 'Example, Pat' }),
  contact({ id: 'mc_hyph', fullName: 'Casey Sample-Example' }),
]

test('a name finds sellers whose name has that word, never a substring inside another word', async () => {
  const { findSellersByName } = await import('../../crmSellers')
  reset(people())
  const ids = async (n: string) => (await findSellersByName(n, ORG)).map(r => r.id).sort()
  assert.deepEqual(await ids('Ann'), ['mc_ann'], '"Ann" is not "Joanne"')
  assert.deepEqual(await ids('son'), [], '"son" is not "Lee Jackson"')
  assert.deepEqual(await ids('ab mc'), ['mc_abby'], 'word starts still find "Abby Mcdermott"')
  assert.deepEqual(await ids('bby rmott'), [], 'but not the middle of her words')
  assert.deepEqual(await ids('Pat Example'), ['mc_rev'], '"Example, Pat" stored last name first')
  assert.deepEqual(await ids('Example'), ['mc_hyph', 'mc_rev'], 'a hyphenated surname counts')
  assert.deepEqual(await ids('Lee Jackson'), ['mc_jackson'])
})

test('LIKE wildcards never reach the database', async () => {
  const { findSellersByName } = await import('../../crmSellers')
  reset(people())
  for (const n of ['Ann%', '%son%', 'Jo_nne Probe', 'a%e%o', 'Lee\\ Jackson']) await findSellersByName(n, ORG)
  // Every string the lookups put in a fullName filter.
  const sent: string[] = []
  const walk = (x: unknown, underName: boolean): void => {
    if (typeof x === 'string') { if (underName) sent.push(x); return }
    if (Array.isArray(x)) { x.forEach(v => walk(v, underName)); return }
    if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) walk(v, underName || k === 'fullName')
  }
  for (const c of fake.calls) if (c.model === 'mojoContact') walk(c.args?.where, false)
  assert.ok(sent.length > 0)
  for (const s of sent.filter(s => s !== 'insensitive')) assert.ok(!/[%_\\]/.test(s), JSON.stringify(s))
  // What is left of a wildcard "name" is a plain name.
  assert.deepEqual((await findSellersByName('Ann%', ORG)).map(r => r.id), ['mc_ann'])
  assert.deepEqual(await findSellersByName('%%%', ORG), [])
})

test('a name and an address that belong to different sellers: no card for whoever is at the address', async () => {
  const { findSeller } = await import('../findSeller')
  reset([
    contact({ id: 'mc_pat', fullName: 'Pat Example', address: '88 Example Ave' }),
    contact({ id: 'mc_jordan', fullName: 'Jordan Sample', address: '12 Sample St' }),
  ])
  assert.deepEqual(await findSeller({ name: 'Jordan Sample', address: '88 Example Ave' }),
    { candidates: [{ kind: 'crm_seller', id: 'mc_pat', name: 'Pat Example', neighborhood: 'Bedford-Stuyvesant' }] })
  const both = await findSeller({ name: 'Pat Example', address: '88 Example Ave' })
  assert.ok('match' in both && both.match.id === 'mc_pat')
  const byAddress = await findSeller({ address: '88 Example Ave' })
  assert.ok('match' in byAddress && byAddress.match.id === 'mc_pat')
})

test('by address (D13 [Ryan, 2026-10-19]): an apostrophe in the stored street does not hide the seller', async () => {
  const { findSellersByAddress } = await import('../../crmSellers')
  for (const [stored, asked] of [
    ["88 St. John's Pl", '88 St Johns Pl'], ["88 St. John's Pl", '88 Saint Johns Place'],
    ["88 O'Example Ave", '88 OExample Ave'], ['88 St Johns Pl', "88 St. John's Place"],
  ]) {
    reset([contact({ id: 'mc_one', address: stored }), contact({ id: 'mc_188', address: stored.replace(/^88/, '188') })])
    assert.deepEqual((await findSellersByAddress(asked, ORG)).map(r => r.id), ['mc_one'], `${asked} vs ${stored}`)
  }
})

test('one seller contact per message: a second, different match in the same turn is a name only', async () => {
  const { runCrmSellerTool, newCrmSellerTurn, ONE_SELLER_PER_MESSAGE } = await import('../crmSellerTools')
  reset(people())
  const turn = newCrmSellerTurn()
  const [a, b, again] = await Promise.all([
    runCrmSellerTool('find_seller', { name: 'Ann Sample' }, turn),
    runCrmSellerTool('find_seller', { name: 'Lee Jackson' }, turn),
    runCrmSellerTool('find_seller', { name: 'Ann Sample' }, turn),
  ])
  assert.equal(a.card?.id, 'mc_ann')
  assert.equal(b.card, null)
  assert.deepEqual(b.forModel, { candidates: [{ kind: 'crm_seller', id: 'mc_jackson', name: 'Lee Jackson', neighborhood: 'Bedford-Stuyvesant' }], note: ONE_SELLER_PER_MESSAGE })
  assert.ok(!JSON.stringify(b.output).includes('555'), 'no phone for the second seller')
  assert.equal(again.card?.id, 'mc_ann', 'the same seller again is still that one card')
  // A new message starts a new turn.
  const next = await runCrmSellerTool('find_seller', { name: 'Lee Jackson' }, newCrmSellerTurn())
  assert.equal(next.card?.id, 'mc_jackson')
})

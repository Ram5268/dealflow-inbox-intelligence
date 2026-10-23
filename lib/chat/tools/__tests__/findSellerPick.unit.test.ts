import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFakePrisma, contact, ORG_ROW, type Row } from '../../__tests__/pr5FakePrisma'

// Brief 43 PR 5 review round 2 (D11 [Ryan, 2026-10-18]: one named seller):
// - two sellers with the same name give candidates, and Ryan's pick ("the
//   Bushwick one") must then be reachable, or the "which one?" question is a
//   dead end that ends in "no seller by that name";
// - titles and the words of an estate, trust or company are not a name:
//   "Mr. Wu" is Pat Wu, while "Estate", "Trust" or "LLC" alone is a search by
//   situation or kind of owner (#14), so it looks up nobody
//   [engineering precaution]. Pure: fake Prisma; fictional names.
const fake = makeFakePrisma({ organization: [ORG_ROW], mojoContact: [] })
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma
const reset = (rows: Row[]) => { fake.tables.mojoContact = rows; fake.calls.length = 0 }

test('same name twice: candidates, then the one Ryan picks by neighborhood', async () => {
  const { findSeller } = await import('../findSeller')
  reset([
    contact({ id: 'mc_bw', fullName: 'Pat Example', neighborhood: 'Bushwick' }),
    contact({ id: 'mc_bs', fullName: 'Pat Example', neighborhood: 'Bedford-Stuyvesant' }),
  ])
  const first = await findSeller({ name: 'Pat Example' })
  assert.ok('candidates' in first && first.candidates.length === 2)
  const picked = await findSeller({ name: 'Pat Example', neighborhood: 'Bushwick' })
  assert.ok('match' in picked && picked.match.id === 'mc_bw', JSON.stringify(picked))
  const spelled = await findSeller({ name: 'Pat Example', neighborhood: 'bed stuy' })
  assert.ok('match' in spelled && spelled.match.id === 'mc_bs', 'any spelling of the neighborhood')
  // A neighborhood that fits neither keeps the question open; a neighborhood alone is nobody.
  assert.ok('candidates' in (await findSeller({ name: 'Pat Example', neighborhood: 'Flatbush' })))
  assert.deepEqual(await findSeller({ neighborhood: 'Bushwick' }), { none: true })
})

test('titles are not part of a name; estate, trust and company words alone look up nobody', async () => {
  const { findSellersByName } = await import('../../crmSellers')
  reset([
    contact({ id: 'mc_wu', fullName: 'Pat Wu' }),
    contact({ id: 'mc_sr', fullName: 'Jordan Probe' }),
    contact({ id: 'mc_jr', fullName: 'Jordan Probe Jr' }),
    contact({ id: 'mc_estate', fullName: 'Estate of Robin Sample' }),
    contact({ id: 'mc_trust', fullName: 'Example Family Trust' }),
    contact({ id: 'mc_llc', fullName: 'Sample Holdings LLC' }),
  ])
  const ids = async (n: string) => (await findSellersByName(n, ORG_ROW.id)).map(r => r.id).sort()
  assert.deepEqual(await ids('Mr. Wu'), ['mc_wu'])
  assert.deepEqual(await ids('Mrs Wu'), ['mc_wu'])
  for (const n of ['Estate', 'Estate of', 'Trust', 'Family Trust', 'LLC', 'Holdings LLC', 'Inc', 'Jr', 'II', 'The Estate']) {
    assert.deepEqual(await ids(n), [], n)
  }
  // The seller's own name still finds them, with or without the extra words.
  assert.deepEqual(await ids('Estate of Robin Sample'), ['mc_estate'])
  assert.deepEqual(await ids('Robin Sample'), ['mc_estate'])
  assert.deepEqual(await ids('Sample Holdings LLC'), ['mc_llc'])
  assert.deepEqual(await ids('Example Trust'), ['mc_trust'])
  // An exact name with its suffix is that person, never the other one.
  assert.deepEqual(await ids('Jordan Probe Jr'), ['mc_jr'])
  assert.deepEqual(await ids('Jordan Probe'), ['mc_sr'])
})

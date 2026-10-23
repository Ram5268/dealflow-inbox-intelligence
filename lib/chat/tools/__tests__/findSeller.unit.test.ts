import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeFakePrisma, contact, sixHundredFifty, ORG_ROW, type Row } from '../../__tests__/pr5FakePrisma'

// Brief 43 PR 5: find_seller and count_sellers, the only seller tools Drift
// has (D11 [Ryan, 2026-10-18]; by address D13 [Ryan, 2026-10-19]; counts are
// fine, S-02). Pure: fake Prisma that evaluates every where clause.
const fake = makeFakePrisma({ organization: [ORG_ROW], mojoContact: [] })
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

const reset = (rows: Row[]) => { fake.tables.mojoContact = rows; fake.calls.length = 0 }

test('one seller by name: one card, with the Open in CRM link kept out of what Drift reads', async () => {
  const { findSeller, findSellerForModel } = await import('../findSeller')
  reset([
    contact({ id: 'mc_pat', fullName: 'Pat Example', phone: '7185550142', address: '88 Example Ave', metadata: { source: 'crm', crmLeadId: 'lead_pat', lastCallResult: 'Left Message' } }),
    contact({ fullName: 'Jordan Sample' }),
  ])
  const r = await findSeller({ name: 'pat example' })
  assert.ok('match' in r)
  assert.equal(r.match.kind, 'crm_seller')
  assert.equal(r.match.name, 'Pat Example')
  assert.equal(r.match.phone, '(718) 555-0142')
  assert.equal(r.match.address, '88 Example Ave')
  assert.equal(r.match.doNotContact, false)
  assert.match(r.match.crmUrl ?? '', /\/leads\/lead_pat$/)
  const seen = JSON.stringify(findSellerForModel(r))
  assert.ok(!/https?:\/\//.test(seen), 'no URL in the tool result Drift reads (Q19: any URL in its text trips the guard)')
  assert.ok(seen.includes('(718) 555-0142'))
  assert.ok(seen.includes('"kind":"crm_seller"'))
})

test('one seller by address (D13), found among 650 even though it is the oldest', async () => {
  const { findSeller } = await import('../findSeller')
  const rows = sixHundredFifty()
  reset(rows)
  const r = await findSeller({ address: '1001 Example Avenue' })
  assert.ok('match' in r)
  assert.equal(r.match.id, rows[0].id)
})

test('a duplicate name gives up to 3 candidates with name and neighborhood only', async () => {
  const { findSeller } = await import('../findSeller')
  reset([
    contact({ fullName: 'Pat Example', neighborhood: 'Bushwick' }),
    contact({ fullName: 'Pat Example', neighborhood: 'Crown Heights' }),
    contact({ fullName: 'Pat Example', neighborhood: 'Bedford-Stuyvesant' }),
    contact({ fullName: 'Pat Example', neighborhood: 'Flatbush' }),
  ])
  const r = await findSeller({ name: 'Pat Example' })
  assert.ok('candidates' in r)
  assert.equal(r.candidates.length, 3)
  for (const c of r.candidates) assert.deepEqual(Object.keys(c).sort(), ['id', 'kind', 'name', 'neighborhood'])
})

test('name plus address narrows the candidates to that address', async () => {
  const { findSeller } = await import('../findSeller')
  reset([
    contact({ fullName: 'Pat Example', address: '12 Sample St' }),
    contact({ fullName: 'Pat Example', address: '14 Sample St' }),
  ])
  const r = await findSeller({ name: 'Pat Example', address: '14 Sample Street' })
  assert.ok('match' in r)
  assert.equal(r.match.address, '14 Sample St')
})

test('nobody by that name: none', async () => {
  const { findSeller } = await import('../findSeller')
  reset([contact({ fullName: 'Jordan Sample' })])
  assert.deepEqual(await findSeller({ name: 'Pat Example' }), { none: true })
  assert.deepEqual(await findSeller({}), { none: true })
})

test('an opted-out seller comes back marked do not contact', async () => {
  const { findSeller } = await import('../findSeller')
  reset([
    contact({ fullName: 'Pat Example', metadata: { source: 'crm', crmLeadId: 'lead_1', crmOptOut: true } }),
    contact({ fullName: 'Jordan Sample', phoneDncFlags: [true] }),
    contact({ fullName: 'Casey Sample', metadata: { source: 'crm', crmLeadId: 'lead_3', lastCallResult: 'Do Not Call' } }),
  ])
  for (const name of ['Pat Example', 'Jordan Sample', 'Casey Sample']) {
    const r = await findSeller({ name })
    assert.ok('match' in r, name)
    assert.equal(r.match.doNotContact, true, name)
  }
})

test('a CRM buyer (intent BUYER) never comes from find_seller', async () => {
  const { findSeller } = await import('../findSeller')
  reset([contact({ fullName: 'Pat Example', intent: 'BUYER', isTestData: true, budgetMin: 1_500_000, budgetMax: 2_000_000 })])
  assert.deepEqual(await findSeller({ name: 'Pat Example' }), { none: true })
})

test('count_sellers counts ALL sellers in the area: 325 of 650 in Bed-Stuy (not 250 or 500), any spelling', async () => {
  const { countSellers } = await import('../countSellers')
  const rows = sixHundredFifty()
  rows.push(
    contact({ neighborhood: 'Bedford-Stuyvesant', intent: 'BUYER' }),
    contact({ neighborhood: 'Bedford-Stuyvesant', metadata: { source: 'duplicate' } }),
    contact({ neighborhood: 'Bedford-Stuyvesant', isTestData: true }),
    contact({ neighborhood: 'Bed Stuy' }), // an older spelling on a re-keyed record
  )
  reset(rows)
  assert.deepEqual(await countSellers({ neighborhood: 'Bed-Stuy' }), { count: 326, neighborhood: 'Bedford-Stuyvesant' })
  assert.deepEqual(await countSellers({ neighborhood: 'bedstuy' }), { count: 326, neighborhood: 'Bedford-Stuyvesant' })
  assert.deepEqual(await countSellers({ neighborhood: 'Crown Heights' }), { count: 325, neighborhood: 'Crown Heights' })
  assert.deepEqual(await countSellers({}), { count: 651, neighborhood: null })
  assert.deepEqual(await countSellers({ neighborhood: 'Brooklyn' }), { count: 651, neighborhood: 'Brooklyn' })
  assert.equal(fake.calls.every(c => c.op === 'count' || c.model === 'organization'), true, 'a database count, not a list')
})

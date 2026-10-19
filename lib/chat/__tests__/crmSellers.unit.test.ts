import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeFakePrisma, matchesWhere, contact, sixHundredFifty, ORG, ORG_ROW, type Row } from './pr5FakePrisma'

// Brief 43 PR 5 (D11 [Ryan, 2026-10-18]; by address D13 [Ryan, 2026-10-19]):
// the CRM-seller pool and the one-seller lookups, over ALL sellers (no 500 cap).
// Pure: a fake Prisma that evaluates every where clause; no database.
const fake = makeFakePrisma({ organization: [ORG_ROW], mojoContact: [] })
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

const load = () => import('../crmSellers')

function reset(rows: Row[]) {
  fake.tables.mojoContact = rows
  fake.calls.length = 0
}

test('the pool is the nightly scoring pool plus intent SELLER: duplicate, CRM-removed, legacy, test, buyers and other orgs are out', async () => {
  const { crmSellerPoolWhere } = await load()
  const where = crmSellerPoolWhere(ORG)
  const keep = contact({ fullName: 'Probe Keep' })
  const out = [
    contact({ metadata: { source: 'duplicate', duplicateOf: keep.id } }),
    contact({ metadata: { source: 'crm_removed', crmLeadId: 'lead_gone' } }),
    contact({ metadata: { source: 'legacy' } }),
    contact({ metadata: null }),
    contact({ isTestData: true, metadata: { seedBrief: '32' } }),
    contact({ intent: 'BUYER' }),
    contact({ intent: 'RENTER' }),
    contact({ organizationId: 'org_other' }),
  ]
  assert.equal(matchesWhere(keep, where), true)
  for (const r of out) assert.equal(matchesWhere(r, where), false, JSON.stringify(r.metadata) + ' ' + r.intent + ' ' + r.organizationId)
})

test("the pool keeps the scoring pool's own filter (lib/matching/nightly/runScoring.ts loadScoringInputs)", () => {
  // A read-only drift check: if the nightly's seller filter changes, this pool must follow it.
  const src = readFileSync(join(__dirname, '../../matching/nightly/runScoring.ts'), 'utf8')
  assert.match(src, /isTestData: false, metadata: \{ path: \['source'\], equals: 'crm' \}/)
})

test('by name: the OLDEST of 650 sellers (outside the newest 500) is found, as one row', async () => {
  const { findSellersByName } = await load()
  const rows = sixHundredFifty()
  reset(rows)
  const oldest = rows[0]
  assert.equal(oldest.fullName, 'Probe Seller 0001')
  const found = await findSellersByName('probe seller 0001', ORG)
  assert.deepEqual(found.map(r => r.id), [oldest.id])
  // The filter ran in the database (no newest-500 window, no load-and-filter).
  const q = fake.calls.find(c => c.model === 'mojoContact' && c.op === 'findMany')!
  assert.equal(q.args?.take !== undefined && (q.args.take as number) >= 500, false)
  assert.ok(q.returned < 650)
})

test('by name: a phrase, the other word order, and a too-short name', async () => {
  const { findSellersByName } = await load()
  reset([
    contact({ fullName: 'Pat Q Example' }),
    contact({ fullName: 'Jordan Sample' }),
  ])
  assert.deepEqual((await findSellersByName('Example', ORG)).map(r => r.fullName), ['Pat Q Example'])
  assert.deepEqual((await findSellersByName('Example Pat', ORG)).map(r => r.fullName), ['Pat Q Example'])
  assert.deepEqual((await findSellersByName('pat example', ORG)).map(r => r.fullName), ['Pat Q Example'])
  assert.deepEqual(await findSellersByName('e', ORG), [])
  assert.deepEqual(await findSellersByName('  ', ORG), [])
})

test('by name: two sellers with the same name both come back; an exact name wins over a longer one', async () => {
  const { findSellersByName } = await load()
  reset([
    contact({ fullName: 'Pat Example', neighborhood: 'Bushwick' }),
    contact({ fullName: 'Pat Example', neighborhood: 'Crown Heights' }),
    contact({ fullName: 'Jordan Sample' }),
    contact({ fullName: 'Jordan Samples' }),
  ])
  assert.equal((await findSellersByName('Pat Example', ORG)).length, 2)
  assert.deepEqual((await findSellersByName('jordan sample', ORG)).map(r => r.fullName), ['Jordan Sample'])
})

test('by name: a CRM buyer, a test row or a duplicate with the name is never returned', async () => {
  const { findSellersByName } = await load()
  reset([
    contact({ fullName: 'Pat Example', intent: 'BUYER' }),
    contact({ fullName: 'Pat Example', isTestData: true }),
    contact({ fullName: 'Pat Example', metadata: { source: 'duplicate' } }),
  ])
  assert.deepEqual(await findSellersByName('Pat Example', ORG), [])
})

test('by address: the OLDEST of 650 is found; the house number must match exactly (88 is not 188)', async () => {
  const { findSellersByAddress } = await load()
  const rows = sixHundredFifty()
  rows.push(
    contact({ fullName: 'Probe Eighty-Eight', address: '88 Example Ave' }),
    contact({ fullName: 'Probe One-Eighty-Eight', address: '188 Example Ave' }),
    contact({ fullName: 'Probe Eight-Eighty', address: '880 Example Ave' }),
  )
  reset(rows)
  assert.deepEqual((await findSellersByAddress('1001 Example Ave', ORG)).map(r => r.id), [rows[0].id])
  assert.deepEqual((await findSellersByAddress('88 Example Avenue, Brooklyn NY 11216', ORG)).map(r => r.fullName), ['Probe Eighty-Eight'])
  assert.deepEqual((await findSellersByAddress('188 example ave', ORG)).map(r => r.fullName), ['Probe One-Eighty-Eight'])
  assert.deepEqual(await findSellersByAddress('8 Example Ave', ORG), [])
  const q = fake.calls.filter(c => c.model === 'mojoContact' && c.op === 'findMany').at(-1)!
  assert.ok(q.returned < 50, `the address filter ran in the database (${q.returned} rows came back)`)
})

test('by address: unit suffixes and street-word spellings are ignored; a missing street type gives every street', async () => {
  const { findSellersByAddress } = await load()
  reset([
    contact({ fullName: 'Probe Avenue', address: '12 Sample Ave # 3' }),
    contact({ fullName: 'Probe Street', address: '12 Sample Street' }),
    contact({ fullName: 'Probe Saint', address: '115 St Marks Ave' }),
    contact({ fullName: 'Probe Queens', address: '88-14 Example Blvd' }),
  ])
  assert.deepEqual((await findSellersByAddress('12 Sample Avenue Apt 2', ORG)).map(r => r.fullName), ['Probe Avenue'])
  assert.deepEqual((await findSellersByAddress('12 sample st', ORG)).map(r => r.fullName), ['Probe Street'])
  assert.deepEqual((await findSellersByAddress('12 Sample', ORG)).map(r => r.fullName).sort(), ['Probe Avenue', 'Probe Street'])
  assert.deepEqual((await findSellersByAddress('115 Saint Marks Avenue', ORG)).map(r => r.fullName), ['Probe Saint'])
  assert.deepEqual((await findSellersByAddress('88-14 Example Boulevard', ORG)).map(r => r.fullName), ['Probe Queens'])
  assert.deepEqual(await findSellersByAddress('Example Ave', ORG), [], 'no house number, no lookup')
})

test('sameStreetAddress: exact house number, normalized street', async () => {
  const { sameStreetAddress } = await load()
  assert.equal(sameStreetAddress('88 Example Ave', '88 Example Avenue'), true)
  assert.equal(sameStreetAddress('88 Example Ave', '188 Example Ave'), false)
  assert.equal(sameStreetAddress('188 Example Ave', '88 Example Ave'), false)
  assert.equal(sameStreetAddress('88 Example Ave', '88 Example St'), false)
  assert.equal(sameStreetAddress('12A Sample St', '12 Sample St'), false)
  assert.equal(sameStreetAddress('88 W 54th St', '88 West 54 Street'), true)
  assert.equal(sameStreetAddress('', '88 Example Ave'), false)
})

test('the card: formatted phone, last call result, CRM link, and the kind PR 3 looks for', async () => {
  const { toSellerCard } = await load()
  const card = toSellerCard(contact({
    id: 'mc_card', fullName: 'Pat Example', phone: '7185550142', address: '88 Example Ave', neighborhood: 'Bedford-Stuyvesant',
    status: 'No Answer', metadata: { source: 'crm', crmLeadId: 'lead_card', lastCallResult: 'Left Message' },
  }) as never)
  assert.deepEqual(card, {
    kind: 'crm_seller', id: 'mc_card', name: 'Pat Example', phone: '(718) 555-0142', address: '88 Example Ave',
    neighborhood: 'Bedford-Stuyvesant', lastCallResult: 'Left Message', status: 'No Answer', doNotContact: false,
    crmUrl: 'https://dealflow-crm-rho.vercel.app/leads/lead_card',
  })
})

test('do not contact: the phone do-not-call flags, the CRM opt-out list, or opt-out wording in the call result', async () => {
  const { doNotContact } = await load()
  const base = contact()
  const dnc = (over: Row) => doNotContact({ ...base, ...over } as never)
  assert.equal(dnc({}), false)
  assert.equal(dnc({ phoneDncFlags: [false] }), false)
  assert.equal(dnc({ phoneDncFlags: [true] }), true)
  assert.equal(dnc({ additionalPhones: ['7185550143'], phoneDncFlags: [false, true] }), true)
  assert.equal(dnc({ metadata: { source: 'crm', crmLeadId: 'x', crmOptOut: true } }), true)
  assert.equal(dnc({ status: 'Do Not Call' }), true)
  assert.equal(dnc({ metadata: { source: 'crm', crmLeadId: 'x', lastCallResult: 'DNC' } }), true)
  assert.equal(dnc({ status: 'Not Interested' }), false)
})

test('formatPhone and opt-out wording', async () => {
  const { formatPhone, isOptOutWording } = await import('../sellerCard')
  assert.equal(formatPhone('7185550142'), '(718) 555-0142')
  assert.equal(formatPhone('+1 718-555-0142'), '(718) 555-0142')
  assert.equal(formatPhone('17185550142'), '(718) 555-0142')
  assert.equal(formatPhone('555-0142'), '555-0142')
  assert.equal(formatPhone(null), null)
  assert.equal(formatPhone(''), null)
  for (const yes of ['Do Not Call', 'DNC', 'dnc list', "don't call", 'Do-Not-Contact', 'not interested — do not contact',
    'Remove me from your list', 'STOP', 'stop calling', 'Opted out', 'unsubscribe', 'take me off the list', 'Cease and desist']) {
    assert.equal(isOptOutWording(yes), true, yes)
  }
  for (const no of ['Not Interested', 'No Answer', 'Contact', 'Left Message', 'Call back Tuesday', 'Wrong Number',
    'said he may stop by', 'Bad Number', 'Appointment Set', '', null]) {
    assert.equal(isOptOutWording(no as string), false, String(no))
  }
})

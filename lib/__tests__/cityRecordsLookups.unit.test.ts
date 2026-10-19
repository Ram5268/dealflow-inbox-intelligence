// Brief 43 PR 11 (Q16, M30): the deed lookup (lib/acris.ts) searches only the
// borough it was given and keeps one tax lot, so the "current owner" and "last
// sale" are that building's; the permits and violations lookup
// (lib/dobLookup.ts) filters by the borough and the full street name. The city
// datasets are a stand-in (fakeCityRecords.ts); nothing leaves this process.
// [engineering precaution]
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { installFakeCityRecords } from './fakeCityRecords'
import * as acris from '../acris'
import * as dob from '../dobLookup'

const city = installFakeCityRecords()
beforeEach(() => city.reset())

type Lookup = (address: string, opts?: { boroughCode?: string | null }) => Promise<acris.ACRISResult | null>
const lookupProperty = acris.lookupProperty as unknown as Lookup

test('the deed lookup asks for the borough it was given, and keeps that borough\'s lot', async () => {
  const qn = await lookupProperty('418 Marigold Street, Queens')
  assert.ok(city.urlsFor('8h5j-fqxa').every(u => /[?&]borough=4(&|$)/.test(u)), city.urlsFor('8h5j-fqxa').join('\n'))
  assert.equal(qn?.borough, '4')
  assert.deepEqual([qn?.block, qn?.lot], ['04444', '0044'])
  assert.equal(qn?.currentOwner, 'SAM PLACEHOLDER')
  assert.equal(qn?.lastSalePrice, 980000)

  city.reset()
  const bk = await lookupProperty('418 Marigold Street', { boroughCode: '3' })
  assert.ok(city.urlsFor('8h5j-fqxa').every(u => /[?&]borough=3(&|$)/.test(u)))
  assert.equal(bk?.borough, '3')
  assert.equal(bk?.currentOwner, 'PAT EXAMPLE')
  assert.equal(bk?.lastSalePrice, 1250000)
})

test('lots from another borough are never merged in, even if the city answers with them', async () => {
  // A records answer that ignores the borough filter (as the chat path's
  // borough-less query used to get): Brooklyn and Queens lots together.
  const { LEGALS } = await import('./fakeCityRecords')
  city.set('8h5j-fqxa', LEGALS.filter(l => l.street_number === '418'))
  const r = await lookupProperty('418 Marigold Street', { boroughCode: '4' })
  assert.equal(r?.borough, '4')
  assert.deepEqual(r?.transfers.map(t => t.documentId), ['QN0000000000001'])
  const masterWhere = city.urlsFor('bnx9-e6tj').join(' ')
  assert.doesNotMatch(masterWhere, /BK0000000000001/, 'no Brooklyn deed is fetched for the Queens building')
})

test('one address with two lots in one borough: one lot is kept, and the other is mentioned', async () => {
  const r = await lookupProperty('88 Example Avenue', { boroughCode: '3' })
  assert.deepEqual([r?.block, r?.lot], ['02222', '0022'], 'the lot with the most filings')
  assert.equal(r?.currentOwner, 'CASEY EXAMPLE', 'not the other lot\'s newer deed')
  assert.deepEqual(r?.transfers.map(t => t.documentId), ['BK0000000000101'])
  assert.equal((r as unknown as { otherLotsAtAddress?: number })?.otherLotsAtAddress, 1)
  assert.match(acris.formatForChat(r!), /1 other tax lot/)
})

test('no borough given (the manual lookup page): still one lot, never a merge', async () => {
  const r = await lookupProperty('418 Marigold Street')
  assert.ok(r)
  const lots = new Set(r!.transfers.map(t => t.documentId.slice(0, 2)))
  assert.equal(lots.size, 1, 'deeds from one borough only')
  assert.equal((r as unknown as { otherLotsAtAddress?: number })?.otherLotsAtAddress, 1)
})

test('"nothing on file" and "the records didn\'t answer" are told apart', async () => {
  const find = (acris as unknown as { findPropertyRecords?: (a: string, o?: { boroughCode?: string | null }) => Promise<{ status: string }> }).findPropertyRecords
  if (!find) return assert.fail('findPropertyRecords is exported')
  assert.equal((await find('418 Marigold Street', { boroughCode: '5' })).status, 'none')
  city.set('8h5j-fqxa', 'fail')
  assert.equal((await find('418 Marigold Street', { boroughCode: '2' })).status, 'failed')
})

// ── DOB ────────────────────────────────────────────────────────────────────────

test('the DOB queries carry the borough (M30)', async () => {
  await dob.lookupDOB('418 Marigold Street, Brooklyn, NY')
  const [permits] = city.whereFor('ipu4-2q9a')
  const [violations] = city.whereFor('3h2n-5cm9')
  assert.match(permits, /borough='BROOKLYN'/)
  assert.match(violations, /boro='3'/)

  city.reset()
  await dob.lookupDOB('418 Marigold Street, Queens')
  assert.match(city.whereFor('ipu4-2q9a')[0], /borough='QUEENS'/)
  assert.match(city.whereFor('3h2n-5cm9')[0], /boro='4'/)
})

test('the DOB queries use the full street name, not its first word', async () => {
  await dob.lookupDOB('11 West 53rd Street, Manhattan')
  const permits = city.whereFor('ipu4-2q9a')[0]
  const violations = city.whereFor('3h2n-5cm9')[0]
  assert.match(permits, /house__='11'/)
  assert.match(violations, /house_number='11'/)
  assert.doesNotMatch(permits, /like 'WEST%'/, 'any West-anything street used to match')
  assert.match(permits, /street_name in \(.*'WEST 53 STREET'.*\)/)
  assert.match(permits, /'WEST 53RD STREET'/)
  assert.match(permits, /'W 53 ST'/)
  assert.doesNotMatch(permits, /'WEST 5 /)
  assert.match(violations, /street in \(.*'WEST 53 STREET'.*\)/)
})

test('Park Avenue and Park Avenue South are different streets', async () => {
  await dob.lookupDOB('250 Park Avenue South, Manhattan')
  const south = city.whereFor('ipu4-2q9a')[0]
  assert.match(south, /'PARK AVENUE SOUTH'/)
  assert.doesNotMatch(south, /'PARK AVENUE'[,)]/)
  city.reset()
  await dob.lookupDOB('250 Park Avenue, Manhattan')
  const park = city.whereFor('ipu4-2q9a')[0]
  assert.match(park, /'PARK AVENUE'/)
  assert.doesNotMatch(park, /SOUTH/)
})

test('a DOB lookup with no borough is never borough-less, and not silently Manhattan', async () => {
  await dob.lookupDOB('418 Marigold Street')
  const permits = city.whereFor('ipu4-2q9a')[0]
  assert.doesNotMatch(permits, /MANHATTAN/)
  assert.match(permits, /borough='BROOKLYN'/, 'Brooklyn is assumed (the chat side lookup says so)')
  assert.match(city.whereFor('3h2n-5cm9')[0], /boro='3'/)
})

test('quotes in a street name cannot break the DOB query', async () => {
  await dob.lookupDOB("12 O'Example Pl, Brooklyn")
  const permits = city.whereFor('ipu4-2q9a')[0]
  // Every quote in the clause opens or closes a value: an even count, none doubled up oddly.
  assert.equal((permits.match(/'/g) ?? []).length % 2, 0, permits)
  assert.match(permits, /'OEXAMPLE PLACE'|'O''EXAMPLE PLACE'/)
})

test('DOB: "none on file" only when both city answers came back empty', async () => {
  const find = (dob as unknown as { findDobRecords?: (a: string, o?: { boroughCode?: string | null }) => Promise<{ status: string }> }).findDobRecords
  if (!find) return assert.fail('findDobRecords is exported')
  assert.equal((await find('418 Marigold Street', { boroughCode: '3' })).status, 'none')
  city.set('3h2n-5cm9', 'fail')
  assert.equal((await find('418 Marigold Street', { boroughCode: '3' })).status, 'failed')
  city.set('ipu4-2q9a', [{ job_type: 'A2', work_type: 'PL', filing_date: '2024-02-01T00:00:00.000', current_status: 'ISSUED' }])
  assert.equal((await find('418 Marigold Street', { boroughCode: '3' })).status, 'found')
})

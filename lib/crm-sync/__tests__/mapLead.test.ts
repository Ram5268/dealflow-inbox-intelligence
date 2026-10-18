import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapLead, phoneKey } from '../mapLead'
import type { CrmFieldValue, CrmLeadRow } from '../crmReader'

const t = (v: string): CrmFieldValue => ({ t: v, n: null, d: null })
const n = (v: number): CrmFieldValue => ({ t: null, n: v, d: null })
const d = (v: string): CrmFieldValue => ({ t: null, n: null, d: v })

const full: CrmLeadRow = {
  id: 'lead_1', mojoId: '90001', name: 'Sam Q Example', displayName: 'Sam Q Example',
  primaryAddressFull: '100 Example St # 3', updatedAt: '2026-09-10 18:08:56.823', contactName: 'Morgan Example',
  phones: ['+13305550142', '+19175550123', '+13305550142'], emails: ['Owner2010@Example.com ', 'second@x.com'],
  fields: {
    'Property City': t('Brooklyn'), 'Property State': t('NY'), 'Property Zip Code': t('11231-1234'),
    'Property Type': t('Duplex'), Bedrooms: n(7), Bathrooms: n(4), 'Square Footage': n(2400), 'Year Built': n(1901),
    'Home Close Date': d('2005-06-15 00:00:00'), 'Mailing Address': t('100 Example Street'),
    'Mailing City': t('Brooklyn'), 'Mailing State': t('NY'), 'Last Dial Date': d('2026-04-16 00:00:00'),
    'Last Contacted Date': d('2026-04-16 11:27:00'), 'Dialer List': t('Brooklyn Brownstones'),
    'Last Call Result': t('Contact'), 'Call Attempts': n(1), Notes: t('[04/16/2026 11:27 AM] left a voicemail\n'),
  },
}
const sparse: CrmLeadRow = {
  id: 'lead_2', mojoId: '90002', name: 'Pat Doe', displayName: 'Pat Doe', primaryAddressFull: '200 Sample St',
  updatedAt: '2026-09-09 19:20:38', contactName: null, phones: [], emails: [], fields: {},
}
const withType = (type: string) => mapLead({ ...sparse, fields: { 'Property Type': t(type) } })

test('full row maps every field', () => {
  const c = mapLead(full)
  assert.equal(c.mojoId, '90001')
  assert.equal(c.fullName, 'Sam Q Example')
  assert.equal(c.coOwnerFullName, 'Morgan Example')
  assert.deepEqual(c.phones, ['3305550142', '9175550123'])
  assert.deepEqual(c.emails, ['owner2010@example.com', 'second@x.com'])
  assert.equal(c.address, '100 Example St # 3')
  assert.equal(c.city, 'Brooklyn')
  assert.equal(c.state, 'NY')
  assert.equal(c.zipCode, '11231')
  assert.equal(c.neighborhood, 'Carroll Gardens')
  assert.equal(c.propertyTypeDetail, 'Duplex')
  assert.equal(c.unitCount, 2)
  assert.equal(c.propertyBeds, 7)
  assert.equal(c.propertyBaths, 4)
  assert.equal(c.buildingSqft, 2400)
  assert.equal(c.yearBuilt, 1901)
  assert.equal(c.lastSaleDate, '2005-06-15 00:00:00')
  assert.equal(c.alternateAddress, '100 Example Street, Brooklyn, NY')
  assert.equal(c.ownerOccupied, true) // unit suffix and St/Street ignored
  assert.equal(c.lastDialDate, '2026-04-16 00:00:00')
  assert.equal(c.lastCalled, '2026-04-16 11:27:00')
  assert.equal(c.mojoList, 'Brooklyn Brownstones')
  assert.equal(c.status, 'Contact')
  assert.equal(c.notes, '[04/16/2026 11:27 AM] left a voicemail')
  assert.deepEqual(c.metadata, {
    source: 'crm', crmLeadId: 'lead_1', crmUpdatedAt: '2026-09-10 18:08:56.823',
    callAttempts: 1, lastCallResult: 'Contact', syncVersion: 1,
  })
})

test('sparse row maps to nulls and empty lists', () => {
  const c = mapLead(sparse)
  assert.equal(c.fullName, 'Pat Doe')
  assert.deepEqual([c.phones, c.emails], [[], []])
  for (const k of ['coOwnerFullName', 'city', 'zipCode', 'neighborhood', 'propertyTypeDetail', 'unitCount',
    'propertyBeds', 'lastSaleDate', 'alternateAddress', 'ownerOccupied', 'lastCalled', 'status', 'notes'] as const) {
    assert.equal(c[k], null, k)
  }
  assert.equal(c.metadata.callAttempts, null)
})

test('co-owner only when it differs from the owner', () => {
  assert.equal(mapLead({ ...full, contactName: ' sam q  example ' }).coOwnerFullName, null)
  assert.equal(mapLead({ ...full, contactName: '' }).coOwnerFullName, null)
  assert.equal(mapLead({ ...full, contactName: null }).coOwnerFullName, null)
})

test('unit mapping: every Mojo property type', () => {
  assert.equal(withType('Duplex').unitCount, 2)
  assert.equal(withType('Triplex').unitCount, 3)
  assert.equal(withType('Quadruplex').unitCount, 4)
  assert.equal(withType('Apartment House (5+ Units)').unitCount, 5)
  assert.equal(withType('Multi-Family Dwelling').unitCount, null)
  assert.equal(withType('Residential Income (Multi-Family)').unitCount, null)
  assert.equal(withType('Apartment House (5+ Units)').propertyTypeDetail, 'Apartment House (5+ Units)')
})

test('missing mailing address → ownerOccupied and alternateAddress null', () => {
  const fields = { ...full.fields }
  delete fields['Mailing Address']
  const c = mapLead({ ...full, fields })
  assert.equal(c.ownerOccupied, null)
  assert.equal(c.alternateAddress, null)
})

test('different mailing address → ownerOccupied false', () => {
  const c = mapLead({ ...full, fields: { ...full.fields, 'Mailing Address': t('PO Box 1000') } })
  assert.equal(c.ownerOccupied, false)
  assert.equal(c.alternateAddress, 'PO Box 1000, Brooklyn, NY')
})

test('null Lead.name falls back to displayName', () => {
  assert.equal(mapLead({ ...sparse, name: null, displayName: 'Imported Name' }).fullName, 'Imported Name')
  assert.equal(mapLead({ ...sparse, name: '  ', displayName: 'Imported Name' }).fullName, 'Imported Name')
})

test('beds/baths 0 → null (Mojo exports 0 for unknown)', () => {
  const c = mapLead({ ...sparse, fields: { Bedrooms: n(0), Bathrooms: n(0) } })
  assert.equal(c.propertyBeds, null)
  assert.equal(c.propertyBaths, null)
})

test('lastCalled falls back to Last Dial Date; split ZIPs stay unmapped', () => {
  const c = mapLead({ ...sparse, fields: { 'Last Dial Date': d('2026-04-20 00:00:00'), 'Property Zip Code': t('11207-1205') } })
  assert.equal(c.lastCalled, '2026-04-20 00:00:00')
  assert.equal(c.zipCode, '11207')
  assert.equal(c.neighborhood, null)
})

test('phoneKey keeps the last 10 digits', () => {
  assert.equal(phoneKey('+19175550123'), '9175550123')
  assert.equal(phoneKey('(917) 555-0123'), '9175550123')
  assert.equal(phoneKey('12345'), null)
})

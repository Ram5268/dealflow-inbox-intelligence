import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendNew, planSync, type ExistingRow } from '../plan'
import { phoneKey, type CrmContact } from '../mapLead'

const contact = (mojoId: string, fullName: string, address: string): CrmContact => ({
  mojoId, fullName, address, coOwnerFullName: null, phones: [], emails: [], city: 'Brooklyn', state: 'NY', zipCode: '11221',
  neighborhood: null, propertyTypeDetail: null, unitCount: null, propertyBeds: null, propertyBaths: null,
  buildingSqft: null, yearBuilt: null, lastSaleDate: null, alternateAddress: null, ownerOccupied: null,
  lastDialDate: null, lastCalled: null, mojoList: null, status: null, notes: null,
  metadata: { source: 'crm', crmLeadId: `lead_${mojoId}`, crmUpdatedAt: '2026-09-10', callAttempts: 0, lastCallResult: null, syncVersion: 1 },
})
const row = (id: string, mojoId: string, fullName: string, address: string, intact = true): ExistingRow => ({
  id, mojoId, fullName, address, state: intact ? 'NY' : address, zipCode: intact ? '11221-1230' : address,
  phone: null, additionalPhones: [], email: null, additionalEmails: [],
})

test('exact mojoId row is the keeper; its csv twin becomes a duplicate', () => {
  const plan = planSync([contact('13628', 'Chris Example', '12 500th St')], [
    row('num', '13628', 'Chris Example', '12 500th St'),
    row('csv', 'csv_chris_example_9139', 'CHRIS EXAMPLE', '12 500th Street', false),
  ])
  assert.equal(plan.upserts[0].keeper?.id, 'num')
  assert.deepEqual(plan.duplicates, [{ id: 'csv', keeper_id: 'num' }])
  assert.deepEqual([plan.rekeys, plan.skipped], [[], []])
})

test('csv-only person: the intact copy is re-keyed to the CRM mojoId, the scrambled copy is a duplicate', () => {
  const plan = planSync([contact('14592', 'Robin Sample', '40 Sample Ave')], [
    row('scrambled', 'csv_robin_sample_1919', 'Robin Sample', '40 Sample Ave', false),
    row('intact', 'csv_robin_sample_0274', 'Robin Sample', '40 Sample Ave'),
  ])
  assert.equal(plan.upserts[0].keeper?.id, 'intact')
  assert.deepEqual(plan.rekeys, [{ id: 'intact', old_id: 'csv_robin_sample_0274', new_id: '14592' }])
  assert.deepEqual(plan.duplicates, [{ id: 'scrambled', keeper_id: 'intact' }])
})

test('csv-only person with no single intact copy is skipped, never inserted', () => {
  for (const rows of [
    [row('a', 'csv_a', 'Dana Placeholder', '50 Placeholder St', false), row('b', 'csv_b', 'Dana Placeholder', '50 Placeholder St', false)],
    [row('a', 'csv_a', 'Dana Placeholder', '50 Placeholder St'), row('b', 'csv_b', 'Dana Placeholder', '50 Placeholder St')],
  ]) {
    const plan = planSync([contact('14428', 'Dana Placeholder', '50 Placeholder St')], rows)
    assert.deepEqual([plan.upserts, plan.rekeys, plan.duplicates], [[], [], []])
    assert.equal(plan.skipped.length, 1)
    assert.deepEqual(plan.skipped[0].rowIds, ['a', 'b'])
  }
})

test('a csv row matching more than one CRM lead is skipped and reported, not marked', () => {
  const plan = planSync(
    [contact('1', 'Jo Lee', '1 Main St'), contact('2', 'Jo Lee', '1 Main Street')],
    [row('num1', '1', 'Jo Lee', '1 Main St'), row('csv', 'csv_jo_lee', 'Jo Lee', '1 Main St')],
  )
  assert.deepEqual(plan.duplicates, [])
  assert.deepEqual(plan.upserts.map(u => u.keeper?.id ?? null), ['num1']) // lead 2 has no safe keeper
  assert.ok(plan.skipped.every(s => s.rowIds.includes('csv')))
  assert.equal(plan.skipped.length, 2)
})

test('a genuinely new lead is an insert; numeric rows are never grouped by name', () => {
  const plan = planSync([contact('14999', 'New Person', '9 New St')], [row('other', '1234', 'New Person', '9 New St')])
  assert.equal(plan.upserts[0].keeper, null)
  assert.deepEqual([plan.duplicates, plan.rekeys, plan.skipped], [[], [], []])
})

test('second run after re-key: same keeper, no re-key, same duplicates', () => {
  const plan = planSync([contact('14592', 'Robin Sample', '40 Sample Ave')], [
    row('scrambled', 'csv_robin_sample_1919', 'Robin Sample', '40 Sample Ave', false),
    row('intact', '14592', 'Robin Sample', '40 Sample Ave'),
  ])
  assert.equal(plan.upserts[0].keeper?.id, 'intact')
  assert.deepEqual(plan.rekeys, [])
  assert.deepEqual(plan.duplicates, [{ id: 'scrambled', keeper_id: 'intact' }])
})

test('appendNew: existing phones keep their order, new ones append (last 10 digits)', () => {
  assert.deepEqual(appendNew('9175550123', ['7185550100'], ['3305550142', '9175550123', '17185550100'], phoneKey),
    { first: '9175550123', rest: ['7185550100', '3305550142'] })
  assert.deepEqual(appendNew(null, [], ['3305550142', '9175550123'], phoneKey),
    { first: '3305550142', rest: ['9175550123'] })
  assert.deepEqual(appendNew(null, ['7185550100'], ['7185550100', '3305550142'], phoneKey),
    { first: '3305550142', rest: ['7185550100'] })
  assert.deepEqual(appendNew('9175550123', null, [], phoneKey), { first: '9175550123', rest: [] })
})

test('appendNew: emails compare case-insensitively', () => {
  const lower = (s: string) => s.toLowerCase()
  assert.deepEqual(appendNew('Mike@Gmail.com', [], ['mike@gmail.com', 'new@x.com'], lower),
    { first: 'Mike@Gmail.com', rest: ['new@x.com'] })
})

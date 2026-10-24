import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STAND_IN_PREFIX, standInMojoId } from '../crmReader'
import * as reader from '../crmReader'
import { planSync, type ExistingRow } from '../plan'
import { mapLead, type CrmContact } from '../mapLead'
import { EXISTING_SQL } from '../runSync'
import { REKEY_SQL } from '../upsert'
import { assertSelectOnly } from '../roClient'

// Brief 48 (PR 8, item 4.1): CRM leads with no Mojo ID (hand-typed leads, non-Mojo
// uploads) are copied, ranked and matched too, under a stand-in key in the mojoId slot,
// 'crm-' + the CRM lead id; and a seller's DealFlow row is found by its CRM lead id
// (metadata.crmLeadId) when its key changed, so it is re-keyed, never copied twice.
// Pure: no database (noMojoId.integration.test.ts runs the same cases on Postgres).
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
const LEADS_SQL = (reader as unknown as { LEADS_SQL: string }).LEADS_SQL

test('the CRM read takes every lead; one with no Mojo ID (null or empty) gets the stand-in key crm-<lead id>', () => {
  assert.equal(STAND_IN_PREFIX, 'crm-')
  assert.equal(standInMojoId('clx123'), 'crm-clx123')
  const sql = flat(LEADS_SQL)
  assert.doesNotMatch(sql, /"mojoId" IS NOT NULL/)
  assert.ok(sql.includes(`COALESCE(NULLIF(l."mojoId", ''), 'crm-' || l.id) AS "mojoId"`))
  assert.doesNotThrow(() => assertSelectOnly(LEADS_SQL))
})

test('DealFlow\'s existing rows are read with their CRM lead id; a re-key never takes a Mojo ID another row holds', () => {
  assert.ok(flat(EXISTING_SQL).includes(`metadata->>'crmLeadId' AS "crmLeadId"`))
  assert.ok(flat(REKEY_SQL).endsWith(`AND NOT EXISTS (SELECT 1 FROM "MojoContact" x WHERE x."mojoId" = v.new_id)`))
})

const contact = (mojoId: string, leadId: string, fullName = 'Kai Example', address = '5 Example Ave'): CrmContact => ({
  ...mapLead({
    id: leadId, mojoId, name: fullName, displayName: fullName, primaryAddressFull: `${address}, Brooklyn, NY 11221`,
    updatedAt: '2026-10-20 12:00:00', contactName: null, phones: [], emails: [], fields: {},
  }),
})
const row = (id: string, mojoId: string, crmLeadId: string | null, fullName = 'Kai Example', address = '5 Example Ave'): ExistingRow => ({
  id, mojoId, fullName, address, state: 'NY', zipCode: '11221', phone: null, additionalPhones: [], email: null, additionalEmails: [], crmLeadId,
})

test('a hand-typed lead is a new seller under its stand-in key; on the next copy its row is its keeper', () => {
  const first = planSync([contact('crm-lead_h', 'lead_h')], [])
  assert.deepEqual([first.upserts[0].keeper, first.rekeys, first.duplicates], [null, [], []])
  const next = planSync([contact('crm-lead_h', 'lead_h')], [row('mc_h', 'crm-lead_h', 'lead_h')])
  assert.equal(next.upserts[0].keeper?.id, 'mc_h')
  assert.deepEqual(next.rekeys, [])
})

test('a Mojo export later adds a Mojo ID to that lead: the same row is re-keyed, nothing new is copied', () => {
  const plan = planSync([contact('90009', 'lead_h')], [row('mc_h', 'crm-lead_h', 'lead_h')])
  assert.equal(plan.upserts[0].keeper?.id, 'mc_h')
  assert.deepEqual(plan.rekeys, [{ id: 'mc_h', old_id: 'crm-lead_h', new_id: '90009' }])
  assert.deepEqual([plan.duplicates, plan.skipped], [[], []])
})

test('the other way: a lead whose Mojo ID was taken away keeps its row, re-keyed to the stand-in', () => {
  const plan = planSync([contact('crm-lead_p', 'lead_p')], [row('mc_p', '90010', 'lead_p')])
  assert.deepEqual(plan.rekeys, [{ id: 'mc_p', old_id: '90010', new_id: 'crm-lead_p' }])
})

test('the Mojo ID it gets already has an older DealFlow row: that row keeps the seller, the stand-in row becomes its duplicate', () => {
  const plan = planSync([contact('90011', 'lead_h')], [row('legacy', '90011', null), row('mc_h', 'crm-lead_h', 'lead_h')])
  assert.equal(plan.upserts[0].keeper?.id, 'legacy')
  assert.deepEqual(plan.rekeys, [])
  assert.deepEqual(plan.duplicates, [{ id: 'mc_h', keeper_id: 'legacy' }])
})

test('a row another lead claims by its Mojo ID is never taken; two old rows for one lead fall back to the copy as before', () => {
  // lead_a's old row now carries lead_b's Mojo ID: it's lead_b's.
  const claimed = planSync([contact('90012', 'lead_b', 'Lee Sample'), contact('crm-lead_a', 'lead_a')], [row('mc_x', '90012', 'lead_a')])
  assert.equal(claimed.upserts.find(u => u.contact.mojoId === '90012')?.keeper?.id, 'mc_x')
  assert.equal(claimed.upserts.find(u => u.contact.mojoId === 'crm-lead_a')?.keeper, null)
  assert.deepEqual(claimed.rekeys, [])
  const two = planSync([contact('90013', 'lead_h')], [row('old1', 'crm-lead_h', 'lead_h'), row('old2', '90001', 'lead_h')])
  assert.equal(two.upserts[0].keeper, null)
  assert.deepEqual([two.rekeys, two.duplicates], [[], []])
})

test('existing sellers keyed on their Mojo ID plan exactly as before (crmLeadId only matters when the key is new)', () => {
  const rows = [row('mc_1', '90001', 'lead_1', 'Pat Example', '88 Example Ave'), row('csv1', 'csv_jo_1', null, 'Jo Sample', '12 Sample St')]
  const contacts = [contact('90001', 'lead_1', 'Pat Example', '88 Example Ave'), contact('90002', 'lead_2', 'Jo Sample', '12 Sample St')]
  const shape = (p: ReturnType<typeof planSync>) => ({ ...p, upserts: p.upserts.map(u => [u.contact.mojoId, u.keeper?.id ?? null]) })
  const withIds = planSync(contacts, rows)
  const without = planSync(contacts, rows.map(r => ({ ...r, crmLeadId: undefined })))
  assert.deepEqual(shape(withIds), shape(without))
  assert.deepEqual(withIds.rekeys, [{ id: 'csv1', old_id: 'csv_jo_1', new_id: '90002' }])
})

test('the preview counts: no-Mojo-ID leads and new sellers by kind, re-keys, new duplicate marks; ids never printed', async () => {
  const { CRM_MOJO_COUNTS_SQL, DF_STAND_IN_COUNT_SQL, noMojoPlanCounts } = await import('../noMojoPreview')
  assert.doesNotThrow(() => assertSelectOnly(CRM_MOJO_COUNTS_SQL))
  assert.ok(flat(CRM_MOJO_COUNTS_SQL).includes(`count(*) FILTER (WHERE l."mojoId" IS NULL)::int AS "noMojoId"`))
  assert.ok(flat(DF_STAND_IN_COUNT_SQL).includes(`starts_with("mojoId", 'crm-')`))
  const plan = planSync(
    [contact('crm-lead_h', 'lead_h'), contact('90009', 'lead_m', 'Lee Sample', '7 Example Ave'), contact('90010', 'lead_k', 'Jo Sample', '9 Sample St'),
      contact('crm-lead_t', 'lead_t', 'Ash Sample', '3 Sample St'), contact('90011', 'lead_o', 'Ray Sample', '4 Sample St')],
    [row('mc_m', 'crm-lead_m', 'lead_m', 'Lee Sample', '7 Example Ave'), row('mc_k', '90010', 'lead_k', 'Jo Sample', '9 Sample St'),
      row('mc_o', '90011', null, 'Ray Sample', '4 Sample St'), row('mc_o2', 'crm-lead_o', 'lead_o', 'Ray Sample', '4 Sample St')],
  )
  const sources = new Map([['mc_o2', { source: 'crm', crmLeadId: 'lead_o' }]])
  const counts = noMojoPlanCounts(plan, new Set(['crm-lead_t']), sources)
  assert.deepEqual(counts, {
    newSellersWithoutMojoId: 1, newSellersWithMojoId: 0, newSellersNoArea: 0, newSellersLikeExisting: { samePhone: 0, sameNameAndStreet: 0 },
    sellersOnTheirOwnRow: 2, reKeyedByCrmLeadId: 1, reKeyedCsv: 0, reKeysBlocked: 0,
    newDuplicateMarks: { ownOlderRows: 1, csvCopies: 0 }, heldElsewhere: 1, skipped: 0,
  })
  assert.doesNotMatch(JSON.stringify(counts), /lead_|mc_|crm-|9001/)
})

// Brief 48 (PR 8 review r1): a hand-typed lead has only its address line (the CRM's New
// Lead form takes a name and an address). Without a ZIP the matcher keeps every buyer
// (eligibility.ts: an unknown area is kept), so the ZIP comes from the address line.
test('review r1: a lead with no ZIP field takes the ZIP at the end of its address line; a ZIP field wins', async () => {
  const { zipFromAddress } = await import('../mapLead')
  assert.equal(zipFromAddress('12 Sample St, Brooklyn, NY 11221'), '11221')
  assert.equal(zipFromAddress('12 Sample St Brooklyn NY 11221-1234 '), '11221')
  for (const none of [null, undefined, '', '12 Sample St', '12 Sample St, Brooklyn, NY', '123456', 'Unit 112210']) assert.equal(zipFromAddress(none), null, String(none))
  const lead = { id: 'lead_z', mojoId: 'crm-lead_z', name: 'Kai Example', displayName: 'Kai Example', updatedAt: '2026-10-20 12:00:00', contactName: null, phones: [], emails: [] }
  const typed = mapLead({ ...lead, primaryAddressFull: '5 Example Ave, Brooklyn, NY 11221', fields: {} })
  assert.deepEqual([typed.address, typed.zipCode, typed.neighborhood], ['5 Example Ave', '11221', 'Bushwick'])
  const field = mapLead({ ...lead, primaryAddressFull: '5 Example Ave, Brooklyn, NY 11221', fields: { 'Property Zip Code': { t: '11231', n: null, d: null } } })
  assert.equal(field.zipCode, '11231')
  const bad = mapLead({ ...lead, primaryAddressFull: '5 Example Ave, Brooklyn, NY 11221', fields: { 'Property Zip Code': { t: 'Brooklyn', n: null, d: null } } })
  assert.equal(bad.zipCode, null) // a field that is there is read as before
  assert.equal(mapLead({ ...lead, primaryAddressFull: '5 Example Ave', fields: {} }).zipCode, null)
})

test('review r1: the preview counts new sellers that look like a seller DealFlow has, new sellers with no area, and blocked re-keys', async () => {
  const { noMojoPlanCounts } = await import('../noMojoPreview')
  const rows = [row('mc_pat', '90001', 'lead_1', 'Pat Example', '88 Example Ave'), row('mc_h', 'crm-lead_h', 'lead_h')]
  rows[0].phone = '7185550142'
  const twin = mapLead({ id: 'lead_tw', mojoId: 'crm-lead_tw', name: 'Pat Example', displayName: 'Pat Example', primaryAddressFull: '88 Example Ave',
    updatedAt: '2026-10-20 12:00:00', contactName: null, phones: ['+17185550142'], emails: [], fields: {} })
  const plan = planSync([contact('90001', 'lead_1', 'Pat Example', '88 Example Ave'), twin, contact('90020', 'lead_h')], rows)
  const sources = new Map([['mc_pat', { source: 'crm', crmLeadId: 'lead_1' }], ['mc_h', { source: 'crm', crmLeadId: 'lead_h' }]])
  const counts = noMojoPlanCounts(plan, new Set(['90020']), sources, rows)
  assert.equal(counts.newSellersWithoutMojoId, 1)
  assert.equal(counts.newSellersNoArea, 1) // the twin's address line has no ZIP
  assert.deepEqual(counts.newSellersLikeExisting, { samePhone: 1, sameNameAndStreet: 1 })
  assert.deepEqual([counts.reKeyedByCrmLeadId, counts.reKeysBlocked], [0, 1]) // 90020 is held by test data
})

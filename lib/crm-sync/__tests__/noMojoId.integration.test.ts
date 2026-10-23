// Brief 48 (PR 8, item 4.1): CRM leads with no Mojo ID are copied, under the stand-in key
// crm-<CRM lead id>, and never twice: on a re-run, when a later Mojo export gives the lead
// a Mojo ID, when that Mojo ID already has an older DealFlow row, and when the CRM itself
// ends up with a second lead for the person. Real Postgres 18 (DealFlow's DATABASE_URL and
// a CRM CRM_TEST_DATABASE_URL, both *_test), the made-up people of crmSyncDb.ts.
// npm run test:integration, or alone:
//   DATABASE_URL=<dealflow *_test> CRM_TEST_DATABASE_URL=<crm *_test> npx --yes tsx --test <this file>
// Skipped without CRM_TEST_DATABASE_URL.
// First, so the guard runs before anything touches a database.
import '../../__tests__/requireTestDb'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { prisma } from '../../prisma'
import { contactScopeWhere } from '../../ranking/queueBuilder'
import { closeCrmPool } from '../roClient'
import { runCrmLeadSync } from '../runSync'
import { CRM_LEADS, DF_ORG, DF_ROWS, P, cleanup, createCrmTables, requireTestUrls, seed, type SeedLead } from './crmSyncDb'

const { crmUrl } = requireTestUrls()
const SKIP = !crmUrl
if (SKIP) console.log('skipped: set CRM_TEST_DATABASE_URL (a CRM *_test database) to run the no-Mojo-ID DB test')
else process.env.DATABASE_URL_CRM_RO = crmUrl

const df = new pg.Client({ connectionString: process.env.DATABASE_URL })
const crm = new pg.Client({ connectionString: crmUrl })

before(async () => {
  if (SKIP) return
  await df.connect()
  await crm.connect()
  const [{ d }] = (await df.query('SELECT current_database() AS d')).rows
  const [{ c }] = (await crm.query('SELECT current_database() AS c')).rows
  assert.ok(/(_test|_perf)$/.test(d) && /(_test|_perf)$/.test(c) && d !== c, 'two distinct test databases')
  await createCrmTables(crm)
})

after(async () => {
  if (SKIP) return
  await cleanup(df, crm)
  await df.end()
  await crm.end()
  await prisma.$disconnect()
  await closeCrmPool()
})

const where = { 'Property City': { t: 'Brooklyn' }, 'Property State': { t: 'NY' }, 'Property Zip Code': { t: '11221' }, 'Property Type': { t: 'Duplex' } }
// Typed into the CRM by hand: no Mojo ID.
const HAND: SeedLead = { key: 'hand', mojoId: null, name: 'Kai Example', displayName: 'Kai Example', street: '5 Example Ave', phones: ['+17185550120'], emails: [], fields: where }
// An upload that left the Mojo ID cell empty.
const BLANK: SeedLead = { key: 'blank', mojoId: '', name: 'Lee Sample', displayName: 'Lee Sample', street: '7 Example Ave', phones: ['+17185550121'], emails: [], fields: where }

type Row = { id: string; mojoId: string; source: string | null; crmLeadId: string | null; duplicateOf: string | null }
const rows = async (): Promise<Row[]> => (await df.query(`
  SELECT id, "mojoId", metadata->>'source' AS source, metadata->>'crmLeadId' AS "crmLeadId", metadata->>'duplicateOf' AS "duplicateOf"
  FROM "MojoContact" WHERE "organizationId" = $1 AND NOT "isTestData" ORDER BY "mojoId"`, [DF_ORG])).rows
// Every CRM lead has exactly one live DealFlow seller (source crm). Not the lead whose
// Mojo ID a test-data row holds: the copy leaves that one alone, before PR 8 and after.
async function oneSellerPerLead() {
  const leadIds = (await crm.query(`SELECT id FROM "Lead" WHERE starts_with(id, $1) AND id <> $2`, [P, `${P}lead_testRow`])).rows.map(r => r.id as string)
  const live = (await rows()).filter(r => r.source === 'crm')
  for (const id of leadIds) assert.equal(live.filter(r => r.crmLeadId === id).length, 1, id)
  assert.equal(live.length, leadIds.length)
}

test('a lead with no Mojo ID, or an empty one, is copied once under crm-<lead id>; a re-run copies nothing new; it is in the scoring and call-list set', { skip: SKIP }, async () => {
  await cleanup(df, crm)
  await seed(df, crm, [...CRM_LEADS, HAND, BLANK])
  const first = await runCrmLeadSync()
  assert.equal(first.inserted, 3) // the new Mojo lead of the base seed, HAND and BLANK
  const byKey = new Map((await rows()).map(r => [r.mojoId, r]))
  for (const k of ['hand', 'blank']) {
    const r = byKey.get(`crm-${P}lead_${k}`)
    assert.ok(r, k)
    assert.deepEqual([r.source, r.crmLeadId], ['crm', `${P}lead_${k}`])
  }
  // Every seller DealFlow had keeps its own row.
  for (const r of DF_ROWS) assert.ok((await rows()).some(x => x.id === r.id) || r.isTestData, String(r.id))
  await oneSellerPerLead()

  const second = await runCrmLeadSync()
  assert.deepEqual([second.inserted, second.rekeyed, second.duplicatesMarked, second.removedMarked], [0, 0, 0, 0])

  // The nightly scores, and the call list ranks, every live CRM seller (runScoring.ts, queueBuilder.ts).
  const org = DF_ORG
  const scoring = await prisma.mojoContact.findMany({ where: { organizationId: org, isTestData: false, metadata: { path: ['source'], equals: 'crm' } }, select: { mojoId: true } })
  const callList = await prisma.mojoContact.findMany({ where: contactScopeWhere(org, 'crm'), select: { mojoId: true } })
  for (const set of [scoring, callList]) {
    assert.ok(set.some(s => s.mojoId === `crm-${P}lead_hand`) && set.some(s => s.mojoId === `crm-${P}lead_blank`))
  }
})

test('a later Mojo export adds a Mojo ID to the hand-typed lead: the same row is re-keyed, no second row', { skip: SKIP }, async () => {
  await cleanup(df, crm)
  await seed(df, crm, [...CRM_LEADS, HAND])
  await runCrmLeadSync()
  const standIn = (await rows()).find(r => r.mojoId === `crm-${P}lead_hand`)!
  // What the CRM importer's merge does (commit-worker.ts: a Mojo ID only fills a blank).
  await crm.query(`UPDATE "Lead" SET "mojoId" = $1 WHERE id = $2 AND "mojoId" IS NULL`, [`${P}m_handlater`, `${P}lead_hand`])
  const r = await runCrmLeadSync()
  assert.deepEqual([r.rekeyed, r.inserted, r.removedMarked], [1, 0, 0])
  const now = (await rows()).filter(x => x.crmLeadId === `${P}lead_hand`)
  assert.deepEqual(now.map(x => [x.id, x.mojoId, x.source]), [[standIn.id, `${P}m_handlater`, 'crm']])
  await oneSellerPerLead()
  // And back: a lead whose Mojo ID is taken away keeps its row too.
  await crm.query(`UPDATE "Lead" SET "mojoId" = NULL WHERE id = $1`, [`${P}lead_edited`])
  const back = await runCrmLeadSync()
  assert.deepEqual([back.rekeyed, back.inserted], [1, 0])
  assert.equal((await rows()).find(x => x.id === `${P}mc_edited`)?.mojoId, `crm-${P}lead_edited`)
  await oneSellerPerLead()
})

test('the Mojo ID it gets already has an older DealFlow row: that row becomes the seller, the stand-in row is marked its duplicate', { skip: SKIP }, async () => {
  await cleanup(df, crm)
  const older = { id: `${P}mc_older`, mojoId: `${P}m_older`, fullName: 'Kai Example', phone: '7185550120', address: '5 Example Ave', metadata: null }
  await seed(df, crm, [...CRM_LEADS, HAND], [...DF_ROWS, older])
  await runCrmLeadSync()
  const standIn = (await rows()).find(r => r.mojoId === `crm-${P}lead_hand`)!
  await crm.query(`UPDATE "Lead" SET "mojoId" = $1 WHERE id = $2`, [`${P}m_older`, `${P}lead_hand`])
  const r = await runCrmLeadSync()
  assert.deepEqual([r.rekeyed, r.inserted, r.duplicatesMarked], [0, 0, 1])
  const all = await rows()
  assert.deepEqual(all.find(x => x.id === older.id), { id: older.id, mojoId: `${P}m_older`, source: 'crm', crmLeadId: `${P}lead_hand`, duplicateOf: null })
  assert.deepEqual(all.find(x => x.id === standIn.id)?.source, 'duplicate')
  assert.deepEqual(all.find(x => x.id === standIn.id)?.duplicateOf, older.id)
  await oneSellerPerLead()
})

test('the Mojo ID it gets is held by a test-data row: the copy still runs (that seller is left alone, as such a lead always was)', { skip: SKIP }, async () => {
  await cleanup(df, crm)
  await seed(df, crm, [...CRM_LEADS, HAND])
  await runCrmLeadSync()
  await crm.query(`UPDATE "Lead" SET "mojoId" = $1 WHERE id = $2`, [`${P}m_testrow_2`, `${P}lead_hand`])
  await df.query(`INSERT INTO "MojoContact" (id, "mojoId", "fullName", "isTestData", "updatedAt", "organizationId") VALUES ($1, $2, 'Test Seller', true, now(), $3)`,
    [`${P}mc_testrow_2`, `${P}m_testrow_2`, DF_ORG])
  const r = await runCrmLeadSync()
  assert.deepEqual([r.rekeyed, r.inserted], [0, 0])
  assert.equal((await df.query(`SELECT "fullName" FROM "MojoContact" WHERE id = $1`, [`${P}mc_testrow_2`])).rows[0].fullName, 'Test Seller')
})

test('the hand-typed person imported again as a second CRM lead: DealFlow keeps one seller per CRM lead, as the CRM holds them', { skip: SKIP }, async () => {
  await cleanup(df, crm)
  const again: SeedLead = { ...HAND, key: 'hand2', mojoId: `${P}m_hand2` }
  await seed(df, crm, [...CRM_LEADS, HAND, again])
  const r = await runCrmLeadSync()
  assert.equal(r.inserted, 3)
  await oneSellerPerLead()
  assert.equal((await runCrmLeadSync()).inserted, 0)
})

test('with the CRM_WINS switch on, the same: copied once, re-keyed when the Mojo ID arrives', { skip: SKIP }, async () => {
  await cleanup(df, crm)
  await seed(df, crm, [...CRM_LEADS, HAND])
  await df.query(`INSERT INTO "FeatureFlag" (id, enabled, "updatedAt") VALUES ('CRM_WINS', true, now())`)
  assert.equal((await runCrmLeadSync()).inserted, 2)
  await crm.query(`UPDATE "Lead" SET "mojoId" = $1 WHERE id = $2`, [`${P}m_handlater`, `${P}lead_hand`])
  const r = await runCrmLeadSync()
  assert.deepEqual([r.crmWins, r.rekeyed, r.inserted], [true, 1, 0])
  await oneSellerPerLead()
})

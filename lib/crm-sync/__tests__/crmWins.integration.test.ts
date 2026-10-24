// Brief 48 (PR 7): the CRM lead copy with the CRM_WINS switch on, against real Postgres 18
// (DealFlow's database, DATABASE_URL, and a CRM one, CRM_TEST_DATABASE_URL, both *_test),
// with the made-up people of crmSyncDb.ts. It checks the rules case by case, that the SQL
// gives exactly what the in-memory rules (the preview's) predict for every seller, that the
// audit row counts changes per field as the preview counts them, that a second copy changes
// nothing, and that a dry run writes nothing. npm run test:integration, or alone:
//   DATABASE_URL=<dealflow *_test> CRM_TEST_DATABASE_URL=<crm *_test> npx --yes tsx --test <this file>
// Skipped without CRM_TEST_DATABASE_URL.
// First, so the guard runs before anything touches a database.
import '../../__tests__/requireTestDb'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { prisma } from '../../prisma'
import { closeCrmPool } from '../roClient'
import { readCrmLeads, readCrmOptOutLeadIds } from '../crmReader'
import { mapLead, markOptOut } from '../mapLead'
import { planSync, type ExistingRow } from '../plan'
import { EXISTING_SQL, ORG_SLUG, runCrmLeadSync } from '../runSync'
import {
  CURRENT_SQL, NOTES_KEPT_HEADING, crmOwnName, crmWinsAfter, crmWinsKeepStatus, crmWinsPreview, runCrmWinsSwitch, toCrmWinsRow, type CurrentRow,
} from '../crmWins'
import { CRM_ORG, DF_ORG, P, cleanup, createCrmTables, dump, requireTestUrls, seed, withoutMs, type SeedLead } from './crmSyncDb'

const { crmUrl } = requireTestUrls()
const SKIP = !crmUrl
if (SKIP) console.log('skipped: set CRM_TEST_DATABASE_URL (a CRM *_test database) to run the CRM-wins DB test')
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

const json = (v: unknown) => JSON.parse(JSON.stringify(v))
const current = async () => new Map((await df.query(CURRENT_SQL, [DF_ORG])).rows.map(r => [r.id as string, { before: r.before, flagged: r.flagged } as CurrentRow]))

// Tomorrow's copy planned exactly as runSync plans it (opt-outs included).
async function planned() {
  const leads = await readCrmLeads(ORG_SLUG)
  const optOuts = await readCrmOptOutLeadIds(ORG_SLUG)
  const contacts = leads.map(mapLead).map(c => markOptOut(c, optOuts))
  const plan = planSync(contacts, (await df.query(EXISTING_SQL, [DF_ORG])).rows as ExistingRow[])
  return { plan, ownNames: new Map(leads.map(l => [l.mojoId, crmOwnName(l)])) }
}

async function seededOn() {
  await cleanup(df, crm)
  await seed(df, crm)
  await df.query(`INSERT INTO "FeatureFlag" (id, enabled, "updatedAt") VALUES ('CRM_WINS', true, now())`)
}

test('switch on: the SQL writes what the in-memory rules predict, and the audit row counts what the preview counts', { skip: SKIP }, async () => {
  await seededOn()
  const { plan, ownNames } = await planned()
  const was = await current()
  const preview = crmWinsPreview(plan, was, ownNames)
  const result = await runCrmLeadSync()
  const now = await current()

  let compared = 0
  for (const u of plan.upserts) {
    if (!u.keeper) continue
    const cur = was.get(u.keeper.id)!
    const keep = crmWinsKeepStatus(cur.before.status, u.contact.status)
    const predicted = crmWinsAfter(cur.before, toCrmWinsRow(u, ownNames.get(u.contact.mojoId) ?? null, keep), cur.flagged)
    // metadata: crmUpdatedAt and friends merge in as the copy always did.
    assert.deepStrictEqual(json(now.get(u.keeper.id)!.before), json(predicted), u.contact.mojoId)
    compared++
  }
  assert.equal(compared, 8)
  assert.equal(result.crmWins, true)
  assert.deepStrictEqual(result.changed, preview.withCrmWins.changed)
  assert.deepStrictEqual(result.filled, preview.withCrmWins.filled)
  assert.equal(result.notesKeptBelow, preview.withCrmWins.notesKeptBelow)
  assert.equal(preview.withCrmWins.wentBlank, 0)
  assert.deepStrictEqual(preview.keepOldToday.changed, {})
  const [audit] = (await df.query(`SELECT "detailsJson" AS d FROM "AuditLog" WHERE "organizationId" = $1 AND action = 'CRM_LEAD_SYNC'`, [DF_ORG])).rows
  assert.deepStrictEqual(audit.d.changed, result.changed)
  assert.equal(audit.d.crmWins, true)
})

test('switch on, case by case', { skip: SKIP }, async () => {
  await seededOn()
  const result = await runCrmLeadSync()
  const { contacts } = json(await dump(df))
  const row = (k: string) => contacts.find((r: { mojoId: string }) => r.mojoId === k)

  // Ryan's CRM edits arrive: name, last called / dialed, status, phone and email lists, notes.
  const edited = row(`${P}m_edited`)
  assert.equal(edited.fullName, 'Pat Example')
  assert.equal(edited.lastCalled, '2026-10-15T10:30:00')
  assert.equal(edited.lastDialDate, '2026-10-15T00:00:00')
  assert.equal(edited.status, 'Contact')
  assert.deepEqual([edited.phone, edited.additionalPhones], ['7185550102', ['7185550101']])
  assert.deepEqual([edited.email, edited.additionalEmails], ['pat@example.com', []])
  // The CRM added to the notes DealFlow had: the CRM's, with no heading.
  assert.equal(edited.notes, 'Left a voicemail. Spoke on 10/15, call back in spring.')
  assert.equal(edited.neighborhood, 'Bedford-Stuyvesant') // written only when first copied

  // A blank in the CRM never erases DealFlow's value.
  const blanks = row(`${P}m_blanks`)
  assert.deepEqual([blanks.yearBuilt, blanks.propertyBeds, blanks.propertyTypeDetail, blanks.unitCount], [1920, 4, 'Triplex', 3])
  assert.equal(blanks.lastCalled, '2026-09-01T15:00:00')
  assert.equal(blanks.notes, 'Owner prefers texts.')

  // Notes DealFlow wrote itself (its old upload) stay, under the heading.
  assert.equal(row(`${P}m_notes`).notes, `Asked for a valuation.\n\n${NOTES_KEPT_HEADING}\nBeds: 3 | Baths: 2 (old upload)`)
  // A do-not-call status stays; per-phone flags keep the phone list; no CRM name keeps DealFlow's.
  assert.equal(row(`${P}m_dnc`).status, 'Do Not Call')
  assert.deepEqual([row(`${P}m_flags`).phone, row(`${P}m_flags`).additionalPhones, row(`${P}m_flags`).phoneDncFlags], ['7185550107', [], [true]])
  assert.equal(row(`${P}m_noname`).fullName, 'Casey Example')
  // Unchanged: the opt-out mark (metadata merge), test data, the csv re-key, removed and legacy marks.
  assert.equal(row(`${P}m_optout`).metadata.crmOptOut, true)
  assert.equal(row(`${P}m_testrow`).fullName, 'Quinn Example')
  assert.equal(row(`${P}m_testrow`).metadata, null)
  assert.equal(row(`${P}m_csv`).id, `${P}mc_csv1`)
  assert.equal(row(`${P}m_csv`).notes, 'Beds: 4 | Baths: 2')
  assert.equal(row(`csv_${P}jordan_2`).metadata.source, 'duplicate')
  assert.equal(row(`${P}m_removed`).metadata.source, 'crm_removed')
  assert.equal(row(`${P}legacy`).metadata.source, 'legacy')

  // A new seller is written exactly as with the switch off (the golden's row).
  const golden = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'crmSync.flagOff.golden.json'), 'utf8'))
  const goldenNew = golden.contacts.find((r: { mojoId: string }) => r.mojoId === `${P}m_new`)
  assert.deepStrictEqual(row(`${P}m_new`), goldenNew)

  assert.deepEqual([result.inserted, result.rekeyed, result.duplicatesMarked, result.removedMarked, result.legacyMarked], [1, 1, 1, 1, 1])
  assert.equal(result.notesKeptBelow, 1)
  assert.deepStrictEqual(result.changed, { fullName: 1, phone: 1, email: 1, lastDialDate: 1, lastCalled: 1, status: 1, notes: 2 })
  assert.deepStrictEqual(result.filled, { additionalPhones: 1, status: 2 })
})

test('switch on: a second copy changes nothing, and a dry run writes nothing', { skip: SKIP }, async () => {
  await seededOn()
  await runCrmLeadSync()
  const afterFirst = json(await dump(df))
  const second = withoutMs(await runCrmLeadSync())
  assert.deepEqual([second.inserted, second.updated, second.rekeyed, second.duplicatesMarked], [0, 0, 0, 0])
  assert.deepStrictEqual(second.changed, {})
  assert.deepStrictEqual(json(await dump(df)).contacts, afterFirst.contacts)

  await seededOn()
  const before = json(await dump(df))
  const dry = await runCrmLeadSync({ dryRun: true })
  assert.equal(dry.dryRun, true)
  assert.equal(dry.crmWins, true)
  assert.ok(Object.keys(dry.changed ?? {}).length > 0, 'the dry run saw the changes')
  assert.deepStrictEqual(json(await dump(df)), before, 'and wrote nothing (no audit row either)')
})

// ── Brief 48 (PR 7 review r1) ───────────────────────────────────────────────

test('review r1: opt-out wording in a status stays, and a CRM 0 never replaces a number', { skip: SKIP }, async () => {
  await seededOn()
  // DealFlow's status for the no-name seller is opt-out wording Drift reads; the CRM's latest is "Contact".
  await df.query(`UPDATE "MojoContact" SET status = 'Stop calling' WHERE id = $1`, [`${P}mc_noname`])
  // The CRM's Year Built for the blanks seller is 0 (Mojo's unknown); DealFlow has 1920.
  const [{ id: def }] = (await crm.query(`SELECT id FROM "CustomFieldDefinition" WHERE "organizationId" = $1 AND name = 'Year Built'`, [CRM_ORG])).rows
  await crm.query(`INSERT INTO "CustomFieldValue" (id, "organizationId", "definitionId", "objectType", "objectId", "valueNumber") VALUES ($1, $2, $3, 'lead', $4, 0)`,
    [`${P}cfv_r1_year`, CRM_ORG, def, `${P}lead_blanks`])
  const { plan, ownNames } = await planned()
  const was = await current()
  const preview = crmWinsPreview(plan, was, ownNames)
  await runCrmLeadSync()
  const { contacts } = json(await dump(df))
  const row = (k: string) => contacts.find((r: { mojoId: string }) => r.mojoId === k)
  assert.equal(row(`${P}m_noname`).status, 'Stop calling')
  assert.equal(row(`${P}m_blanks`).yearBuilt, 1920)
  // and the in-memory rules (the preview) agree
  const now = await current()
  for (const u of plan.upserts) {
    if (!u.keeper) continue
    const cur = was.get(u.keeper.id)!
    const keep = crmWinsKeepStatus(cur.before.status, u.contact.status)
    assert.deepStrictEqual(json(now.get(u.keeper.id)!.before), json(crmWinsAfter(cur.before, toCrmWinsRow(u, ownNames.get(u.contact.mojoId) ?? null, keep), cur.flagged)), u.contact.mojoId)
  }
  assert.equal(preview.withCrmWins.doNotCallKept, 2) // the Do Not Call seller and this one
})

// 60 made-up sellers, phones (718) 555-0100 to 555-0159.
const MANY = 60
const many = (): { leads: SeedLead[]; rows: Array<Record<string, unknown>> } => {
  const leads: SeedLead[] = [], rows: Array<Record<string, unknown>> = []
  for (let i = 0; i < MANY; i++) {
    const phone = `7185550${String(100 + i).slice(-3)}`
    leads.push({ key: `many${i}`, mojoId: `${P}m_many${i}`, name: `Test Owner ${i}`, displayName: `Test Owner ${i}`, street: `${i + 1} Example Ave`,
      phones: [`+1${phone}`], emails: [], fields: { 'Property City': { t: 'Brooklyn' }, 'Property State': { t: 'NY' }, 'Property Zip Code': { t: '11221' } } })
    rows.push({ id: `${P}mc_many${i}`, mojoId: `${P}m_many${i}`, fullName: `Test Owner ${i}`, phone, address: `${i + 1} Example Ave`, city: 'Brooklyn',
      state: 'NY', zipCode: '11221', metadata: { source: 'crm', crmLeadId: `${P}lead_many${i}` } })
  }
  return { leads, rows }
}
// A broken CRM read: every lead now has the next lead's phone.
const shiftPhones = () => crm.query(`UPDATE "ContactPhone" SET phone = '+1718555' || lpad((100 + ((substring(id from 'many([0-9]+)_')::int + 1) % ${MANY}))::text, 4, '0') WHERE starts_with(id, $1)`, [P])
const phones = async () => (await df.query(`SELECT phone FROM "MojoContact" WHERE "organizationId" = $1 ORDER BY "mojoId"`, [DF_ORG])).rows.map(r => r.phone)
// Brief 48 (PR 7 review r2): through the switch script's own code, which stamps the switch's
// updatedAt (the first-copy pass is keyed on it).
const setSwitch = (on: boolean) => runCrmWinsSwitch(prisma, on ? 'on' : 'off', true)

test('review r1: a later copy that drops most sellers\' phone numbers rolls back; the first copy after switching on is let through', { skip: SKIP }, async () => {
  await cleanup(df, crm)
  const { leads, rows } = many()
  await seed(df, crm, leads, rows)
  await setSwitch(false)
  await runCrmLeadSync() // keep-old
  await setSwitch(true)
  await runCrmLeadSync() // the first CRM-wins copy: nothing to change
  const good = await phones()
  await shiftPhones()
  await assert.rejects(runCrmLeadSync(), /CRM-wins mass change \(rolled back\): phonesDropped 60 sellers, over the limit of 50/)
  assert.deepEqual(await phones(), good, 'nothing written')
  // Turned off and on again: the next copy is a first run, and goes through.
  await setSwitch(false)
  await runCrmLeadSync()
  await setSwitch(true)
  const r = await runCrmLeadSync()
  assert.equal(r.changed?.phone, MANY)
  assert.notDeepEqual(await phones(), good)
})

// ── Brief 48 (PR 7 review r2) ───────────────────────────────────────────────

test('review r2: only turning the switch off and on again gives a free pass; a copy that couldn\'t read the switch doesn\'t', { skip: SKIP }, async () => {
  await cleanup(df, crm)
  const { leads, rows } = many()
  await seed(df, crm, leads, rows)
  await setSwitch(true)
  await runCrmLeadSync() // the first CRM-wins copy: nothing to change
  const good = await phones()
  await shiftPhones()
  await assert.rejects(runCrmLeadSync(), /phonesDropped 60 sellers, over the limit of 50/)
  // One morning the switch can't be read: that copy runs keep-old (and writes its audit row) ...
  await df.query(`ALTER TABLE "FeatureFlag" RENAME TO "FeatureFlag_b48r2"`)
  try {
    assert.equal((await runCrmLeadSync()).crmWins, undefined)
  } finally {
    await df.query(`ALTER TABLE "FeatureFlag_b48r2" RENAME TO "FeatureFlag"`)
  }
  // ... and the next morning's mass change still rolls back.
  await assert.rejects(runCrmLeadSync(), /phonesDropped 60 sellers, over the limit of 50/)
  assert.deepEqual(await phones(), good, 'nothing written')
  // Off and on again with the switch script, no copy in between (the PR's instruction): one morning goes through.
  await setSwitch(false)
  await setSwitch(true)
  assert.equal((await runCrmLeadSync()).changed?.phone, MANY)
})

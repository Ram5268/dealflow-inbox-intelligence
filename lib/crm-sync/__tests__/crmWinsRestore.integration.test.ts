// Brief 48 (PR 7 review r1; data step DS-4) [executor, 2026-10-23]: turning CRM_WINS on
// saves a private before-copy, and --restore puts every column the copy changed back
// exactly. Real Postgres 18 (DealFlow's DATABASE_URL and a CRM CRM_TEST_DATABASE_URL, both
// *_test), the made-up people of crmSyncDb.ts: a keep-old copy (today's state), the
// before-copy and the switch on, a CRM-wins copy that changes values, then the restore:
// the saved sellers' rows are byte for byte what they were, the switch is off, and a
// do-not-contact mark added since stays. npm run test:integration, or alone:
//   DATABASE_URL=<dealflow *_test> CRM_TEST_DATABASE_URL=<crm *_test> npx --yes tsx --test <this file>
// Skipped without CRM_TEST_DATABASE_URL.
// First, so the guard runs before anything touches a database.
import '../../__tests__/requireTestDb'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { prisma } from '../../prisma'
import { privateFileName, writePrivateJson } from '../../privateRecord'
import { closeCrmPool } from '../roClient'
import { runCrmLeadSync } from '../runSync'
import { runCrmWinsSwitch } from '../crmWins'
import { RESTORE_ACTION, applyRestore, parseBeforeCopy, readBeforeCopy, restoreCheck } from '../crmWinsBackup'
import { CRM_ORG, DF_ORG, P, cleanup, createCrmTables, dump, requireTestUrls, seed } from './crmSyncDb'

const { crmUrl } = requireTestUrls()
const SKIP = !crmUrl
if (SKIP) console.log('skipped: set CRM_TEST_DATABASE_URL (a CRM *_test database) to run the CRM-wins restore DB test')
else process.env.DATABASE_URL_CRM_RO = crmUrl

const df = new pg.Client({ connectionString: process.env.DATABASE_URL })
const crm = new pg.Client({ connectionString: crmUrl })
const dir = mkdtempSync(join(tmpdir(), 'b48a-before-'))

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
  rmSync(dir, { recursive: true, force: true })
  if (SKIP) return
  await cleanup(df, crm)
  await df.end()
  await crm.end()
  await prisma.$disconnect()
  await closeCrmPool()
})

const json = (v: unknown) => JSON.parse(JSON.stringify(v))

test('on with a before-copy, a CRM-wins copy, then --restore: byte-identical rows, switch off, a new do-not-contact mark kept', { skip: SKIP }, async () => {
  await cleanup(df, crm)
  await seed(df, crm)
  await runCrmLeadSync() // keep-old, as every morning today
  const saved = json(await dump(df)).contacts

  // --on --apply: the before-copy first (owner-only file), then the switch.
  const copy = await readBeforeCopy(prisma, DF_ORG)
  const file = writePrivateJson(join(dir, 'private'), join(__dirname, '..', '..', '..'), privateFileName('brief48-crm-wins-before', new Date()), copy)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(join(dir, 'private')).mode & 0o777, 0o700)
  assert.deepEqual(await runCrmWinsSwitch(prisma, 'on', true), ['CRM_WINS: off (no row) -> on. The next CRM copy (the nightly run at 09:00 UTC, or scripts/crm-lead-sync.ts) uses it.'])
  const ids = new Set(copy.rows.map(r => r.id as string))
  // Brief 48 (PR 7 review r2): every real row the copy reads (the CRM sellers, 8 that were there and
  // 1 the copy added, plus the duplicate, legacy and removed rows a CRM lead can claim later); not the test row.
  assert.equal(ids.size, 12)

  const r = await runCrmLeadSync()
  assert.ok(Object.keys(r.changed ?? {}).length > 0, 'the copy changed values')
  // A STOP recorded in the CRM after the switch went on (Brief 43 PR 5's mark).
  await df.query(`UPDATE "MojoContact" SET metadata = metadata || '{"crmOptOut": true}' WHERE id = $1`, [`${P}mc_edited`])

  // --restore <file>: the dry run's counts, then the restore.
  const fromFile = parseBeforeCopy(JSON.parse(readFileSync(file, 'utf8')), DF_ORG)
  // The two sellers the CRM-wins copy changed (the edited one, and the one whose own notes moved under the CRM's).
  const check = await restoreCheck(prisma, fromFile)
  assert.deepEqual(check, { rowsInFile: 12, found: 12, missing: 0, differ: 2, statusesKept: 0, addedSince: 0 })
  const res = await applyRestore(prisma, fromFile)
  assert.deepEqual([res.restored, res.stillDiffer], [2, 0])

  type Row = { id: string; metadata: Record<string, unknown> }
  const now: Row[] = json(await dump(df)).contacts
  const pick = (rows: Row[]) => rows.filter(x => ids.has(x.id))
  const expected = pick(saved as Row[]).map(x => (x.id === `${P}mc_edited` ? { ...x, metadata: { ...x.metadata, crmOptOut: true } } : x))
  assert.deepStrictEqual(pick(now), expected)
  const [{ enabled }] = (await df.query(`SELECT enabled FROM "FeatureFlag" WHERE id = 'CRM_WINS'`)).rows
  assert.equal(enabled, false)
  const audit = (await df.query(`SELECT "detailsJson" AS d FROM "AuditLog" WHERE "organizationId" = $1 AND action = $2`, [DF_ORG, RESTORE_ACTION])).rows
  assert.deepEqual(audit.map(a => [a.d.rowsInFile, a.d.missing, a.d.restored]), [[12, 0, 2]])

  // With the switch off again, the next copy is keep-old: it changes nothing back.
  const next = await runCrmLeadSync()
  assert.equal(next.crmWins, undefined)
  assert.deepStrictEqual(pick(json(await dump(df)).contacts), expected)
})

// ── Brief 48 (PR 7 review r2) ───────────────────────────────────────────────

// A CRM lead added after the before-copy (made-up person), with one phone.
async function addCrmLead(key: string, mojoId: string, name: string, street: string, phone: string) {
  await crm.query(`INSERT INTO "Lead" (id, "organizationId", "displayName", name, "primaryAddressFull", "mojoId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $3, $4, $5, now(), now())`,
    [`${P}lead_${key}`, CRM_ORG, name, `${street}, Brooklyn, NY 11221`, mojoId])
  await crm.query(`INSERT INTO "Contact" (id, "organizationId", "leadId", "displayName", "createdAt", "updatedAt") VALUES ($1, $2, $3, 'Test contact', now(), now())`, [`${P}con_${P}lead_${key}`, CRM_ORG, `${P}lead_${key}`])
  await crm.query(`INSERT INTO "ContactPhone" (id, "contactId", phone, type, "isPrimary", "createdAt", "updatedAt") VALUES ($1, $2, $3, 'mobile', true, now(), now())`, [`${P}ph_${key}_0`, `${P}con_${P}lead_${key}`, phone])
}

test('review r2: the restore also puts back rows the copy claimed since, and keeps a do-not-call status that arrived since', { skip: SKIP }, async () => {
  await cleanup(df, crm)
  await seed(df, crm)
  await runCrmLeadSync() // keep-old, as every morning today
  const saved = json(await dump(df)).contacts
  const copy = await readBeforeCopy(prisma, DF_ORG)
  await runCrmWinsSwitch(prisma, 'on', true)

  // After the switch went on, in the CRM: the blanks seller's call result becomes "DNC"; the
  // removed seller comes back, and a lead claims the legacy row, both with other details.
  await crm.query(`UPDATE "CustomFieldValue" v SET "valueText" = 'DNC' FROM "CustomFieldDefinition" d
    WHERE d.id = v."definitionId" AND d.name = 'Last Call Result' AND v."objectId" = $1`, [`${P}lead_blanks`])
  await addCrmLead('back', `${P}m_removed`, 'Jamie Example', '91 Example Ave', '+17185550114')
  await addCrmLead('claims', `${P}legacy`, 'Riley Example', '92 Example Ave', '+17185550115')
  const r = await runCrmLeadSync()
  assert.equal(r.crmWins, true)
  const mid = json(await dump(df)).contacts
  const row = (rows: Array<Record<string, unknown>>, k: string) => rows.find(x => x.mojoId === k)!
  assert.equal(row(mid, `${P}m_blanks`).status, 'DNC')
  assert.equal(row(mid, `${P}legacy`).fullName, 'Riley Example')

  const fromFile = parseBeforeCopy(json(copy), DF_ORG)
  assert.equal((await restoreCheck(prisma, fromFile)).statusesKept, 1)
  const res = await applyRestore(prisma, fromFile)
  assert.equal(res.stillDiffer, 0)
  const now = json(await dump(df)).contacts
  for (const k of [`${P}m_removed`, `${P}legacy`]) {
    const [a, b] = [row(now, k), row(saved, k)]
    assert.deepEqual([a.fullName, a.phone, a.additionalPhones, a.address], [b.fullName, b.phone, b.additionalPhones, b.address], k)
  }
  // The call list's filter (status) and Drift's badge still see the CRM's "DNC".
  assert.equal(row(now, `${P}m_blanks`).status, 'DNC')
  assert.equal(row(now, `${P}m_blanks`).notes, row(saved, `${P}m_blanks`).notes)
})

test('review r2 (nit 5): a switch change between the copy\'s read and its write rolls the copy back; a seller first copied since is counted', { skip: SKIP }, async () => {
  await cleanup(df, crm)
  await seed(df, crm)
  await runCrmLeadSync()
  const copy = await readBeforeCopy(prisma, DF_ORG)
  await runCrmWinsSwitch(prisma, 'on', true)
  const before = json(await dump(df))
  // A restore (or the switch script) commits after the copy read the switch, before it writes.
  const real = prisma.$transaction.bind(prisma)
  ;(prisma as unknown as { $transaction: unknown }).$transaction = async (...args: unknown[]) => {
    await df.query(`UPDATE "FeatureFlag" SET enabled = false, "updatedAt" = now() WHERE id = 'CRM_WINS'`)
    return (real as (...a: unknown[]) => unknown)(...args)
  }
  try {
    await assert.rejects(runCrmLeadSync(), /the CRM_WINS switch changed while the copy was being planned; rolled back/)
  } finally {
    ;(prisma as unknown as { $transaction: unknown }).$transaction = real
  }
  const after = json(await dump(df))
  assert.deepStrictEqual(after.contacts, before.contacts, 'nothing written')
  assert.deepStrictEqual(after.audit, before.audit, 'no audit row either')
  // The switch is off now, so the next copy is keep-old and runs.
  assert.equal((await runCrmLeadSync()).crmWins, undefined)

  // A CRM lead added after the before-copy is copied as a new seller; the dry run counts it.
  await addCrmLead('later', `${P}m_later`, 'Avery Example', '93 Example Ave', '+17185550116')
  await runCrmLeadSync()
  assert.equal((await restoreCheck(prisma, parseBeforeCopy(json(copy), DF_ORG))).addedSince, 1)
})

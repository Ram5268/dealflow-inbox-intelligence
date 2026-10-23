// Brief 48 (PR 7): with the CRM_WINS switch off, the CRM lead copy is byte for byte what
// main 0342554 (before PR 7) does. Golden file: on main, this file seeded made-up people
// (crmSyncDb.ts), ran the copy twice and wrote everything the copy can change (DealFlow's
// rows for the test organization without clock columns, both runs' results and audit rows
// without their run time) to fixtures/crmSync.flagOff.golden.json; on the branch the same
// seed and runs, with no CRM_WINS row and with a row that's off, must give exactly that.
// It only uses code that exists on main, so it can write the golden there:
//   GOLDEN_WRITE=1 DATABASE_URL=<dealflow *_test> CRM_TEST_DATABASE_URL=<crm *_test> npx --yes tsx <this file>
// Real Postgres 18 (the copy's RETURNING old/new): npm run test:integration, or alone as
// above without GOLDEN_WRITE. Skipped without CRM_TEST_DATABASE_URL.
// First, so the guard runs before anything touches a database.
import '../../__tests__/requireTestDb'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { prisma } from '../../prisma'
import { closeCrmPool } from '../roClient'
import { runCrmLeadSync } from '../runSync'
import { P, cleanup, createCrmTables, dump, requireTestUrls, seed, withoutMs } from './crmSyncDb'

const { crmUrl } = requireTestUrls()
const SKIP = !crmUrl
if (SKIP) console.log('skipped: set CRM_TEST_DATABASE_URL (a CRM *_test database) to run the CRM copy golden test')
// roClient.ts reads the setting at its first query, which comes after this line.
else process.env.DATABASE_URL_CRM_RO = crmUrl

const GOLDEN = join(__dirname, 'fixtures', 'crmSync.flagOff.golden.json')
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

async function twoCopies(flag: boolean | null) {
  await cleanup(df, crm)
  await seed(df, crm)
  if (flag !== null) await df.query(`INSERT INTO "FeatureFlag" (id, enabled, "updatedAt") VALUES ('CRM_WINS', $1, now())`, [flag])
  const runs = [withoutMs(await runCrmLeadSync()), withoutMs(await runCrmLeadSync())]
  return json({ runs, ...(await dump(df)) })
}

test('switch off (no row, then a row set to off): two copies give exactly what main gave', { skip: SKIP }, async () => {
  const noRow = await twoCopies(null)
  if (process.env.GOLDEN_WRITE === '1') {
    writeFileSync(GOLDEN, JSON.stringify(noRow, null, 2) + '\n')
    console.log(`wrote ${GOLDEN}`)
    return
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
  assert.deepStrictEqual(noRow, golden)
  assert.deepStrictEqual(await twoCopies(false), golden)
})

test('keep-old (switch off): the CRM\'s newer last-called date, status, phones and notes never reach a seller DealFlow already has', { skip: SKIP }, async () => {
  const { contacts } = await twoCopies(null)
  const edited = contacts.find((r: { mojoId: string }) => r.mojoId === `${P}m_edited`)
  // The CRM says: called 2026-10-15, "Contact", phones 7185550102 + 7185550101, new notes.
  assert.equal(edited.lastCalled, '2026-08-01T09:00:00')
  assert.equal(edited.lastDialDate, '2026-08-01T00:00:00')
  assert.equal(edited.status, 'No Answer')
  assert.equal(edited.fullName, 'Pat Exampel')
  assert.equal(edited.notes, 'Left a voicemail.')
  assert.deepEqual([edited.phone, edited.additionalPhones], ['7185550101', ['7185550102']])
})

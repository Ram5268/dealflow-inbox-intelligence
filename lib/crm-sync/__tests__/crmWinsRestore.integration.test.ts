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
import { DF_ORG, P, cleanup, createCrmTables, dump, requireTestUrls, seed } from './crmSyncDb'

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
  assert.deepEqual(await runCrmWinsSwitch(prisma, 'on', true), ['CRM_WINS: off (no row) -> on. The next CRM copy (7:00 am, or scripts/crm-lead-sync.ts) uses it.'])
  const ids = new Set(copy.rows.map(r => r.id as string))
  assert.equal(ids.size, 9) // the CRM sellers (8 that were there, 1 the copy added), not the test row, duplicate, legacy or removed rows

  const r = await runCrmLeadSync()
  assert.ok(Object.keys(r.changed ?? {}).length > 0, 'the copy changed values')
  // A STOP recorded in the CRM after the switch went on (Brief 43 PR 5's mark).
  await df.query(`UPDATE "MojoContact" SET metadata = metadata || '{"crmOptOut": true}' WHERE id = $1`, [`${P}mc_edited`])

  // --restore <file>: the dry run's counts, then the restore.
  const fromFile = parseBeforeCopy(JSON.parse(readFileSync(file, 'utf8')), DF_ORG)
  // The two sellers the CRM-wins copy changed (the edited one, and the one whose own notes moved under the CRM's).
  const check = await restoreCheck(prisma, fromFile)
  assert.deepEqual(check, { rowsInFile: 9, found: 9, missing: 0, differ: 2 })
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
  assert.deepEqual(audit.map(a => [a.d.rowsInFile, a.d.missing, a.d.restored]), [[9, 0, 2]])

  // With the switch off again, the next copy is keep-old: it changes nothing back.
  const next = await runCrmLeadSync()
  assert.equal(next.crmWins, undefined)
  assert.deepStrictEqual(pick(json(await dump(df)).contacts), expected)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BEFORE_COPY_KIND, BEFORE_COPY_SQL, COPIED_COLUMNS, RestoreRefused, defaultBeforeCopyDir, parseBeforeCopy, parseSwitchCommand,
  restoreCheckSql, restoreSql,
} from '../crmWinsBackup'
import { assertSelectOnly } from '../roClient'

// Brief 48 (PR 7 review r1; data step DS-4) [executor, 2026-10-23]: the CRM_WINS switch's
// private before-copy and --restore. Pure: no database (crmWinsRestore.integration.test.ts
// restores on Postgres).
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

test('the switch command: state, on (with a private folder), off, restore; anything else is usage', () => {
  assert.deepEqual(parseSwitchCommand([]), { kind: 'state' })
  assert.deepEqual(parseSwitchCommand(['--on']), { kind: 'on', dir: null })
  assert.deepEqual(parseSwitchCommand(['--on', '--preimage-dir', '/tmp/x']), { kind: 'on', dir: '/tmp/x' })
  assert.deepEqual(parseSwitchCommand(['--preimage-dir', '/tmp/x', '--on']), { kind: 'on', dir: '/tmp/x' })
  assert.deepEqual(parseSwitchCommand(['--off']), { kind: 'off' })
  assert.deepEqual(parseSwitchCommand(['--restore', 'before.json']), { kind: 'restore', file: 'before.json' })
  for (const bad of [['--restore'], ['--restore', '--on'], ['--off', '--preimage-dir', '/tmp/x'], ['--on', '--preimage-dir'], ['--on', '--off'], ['--yes']]) {
    assert.equal(parseSwitchCommand(bad), 'usage', bad.join(' '))
  }
  assert.equal(defaultBeforeCopyDir('/Users/someone'), '/Users/someone/dev/brief48-dealflow-fixes/private')
})

test('the before-copy: every column the copy writes on an existing seller, CRM sellers only, never test data', () => {
  const sql = flat(BEFORE_COPY_SQL)
  assert.doesNotThrow(() => assertSelectOnly(BEFORE_COPY_SQL))
  assert.match(sql, /WHERE m\."organizationId" = \$1 AND NOT m\."isTestData" AND m\.metadata->>'source' = 'crm'/)
  assert.ok(sql.includes(`'id', m.id, 'mojoId', m."mojoId"`))
  for (const [c] of COPIED_COLUMNS) assert.ok(sql.includes(`'${c}', m."${c}"`), c)
  assert.ok(!COPIED_COLUMNS.some(([c]) => c === 'neighborhood'), 'written only when a seller is first copied')
})

test('a before-copy file is checked first: its kind, organization, known columns only, an id on every row', () => {
  const ok = { kind: BEFORE_COPY_KIND, version: 1, createdAt: '2026-10-23T22:00:00.000Z', organizationId: 'org_1', columns: ['status', 'notes'], rows: [{ id: 'mc_1', status: 'Contact', notes: null }] }
  assert.equal(parseBeforeCopy(ok, 'org_1'), ok)
  const bad: Array<[unknown, RegExp]> = [
    [{ ...ok, kind: 'something else' }, /not a CRM-wins before-copy/],
    [null, /not a CRM-wins before-copy/],
    [{ ...ok, organizationId: 'org_2' }, /another organization/],
    [{ ...ok, columns: ['status', 'id; DROP TABLE x'] }, /columns this code doesn't copy/],
    [{ ...ok, columns: ['neighborhood'] }, /columns this code doesn't copy/],
    [{ ...ok, rows: [{ status: 'Contact' }] }, /a row without an id/],
  ]
  for (const [raw, msg] of bad) assert.throws(() => parseBeforeCopy(raw, 'org_1'), (e: unknown) => e instanceof RestoreRefused && msg.test((e as Error).message))
})

test('the restore puts the saved columns back by id, in the organization, never test data, keeping a do-not-contact mark; its check only reads', () => {
  const cols = ['status', 'lastCalled', 'metadata']
  const upd = flat(restoreSql(cols))
  assert.match(upd, /^UPDATE "MojoContact" AS m SET "updatedAt" = now\(\), "status" = r\."status", "lastCalled" = r\."lastCalled", "metadata" = CASE WHEN m\.metadata->>'crmOptOut' = 'true' THEN COALESCE\(r\.metadata, '\{\}'::jsonb\) \|\| '\{"crmOptOut": true\}'::jsonb ELSE r\.metadata END/)
  assert.ok(upd.includes(`FROM jsonb_to_recordset($1::jsonb) AS r(id text, "status" text, "lastCalled" timestamp, "metadata" jsonb)`))
  assert.ok(upd.includes(`WHERE m.id = r.id AND m."organizationId" = $2 AND NOT m."isTestData" AND (`))
  assert.ok(!upd.includes('"mojoId" ='), 'the key is never written back')
  const check = restoreCheckSql(cols)
  assert.doesNotThrow(() => assertSelectOnly(check))
  assert.deepEqual([...new Set(check.match(/\$\d+/g))].sort(), ['$1', '$2'])
})

test('the switch script saves the before-copy before turning the switch on, and never prints it', () => {
  const src = readFileSync(join(__dirname, '../../../scripts/brief48-crm-wins-switch.ts'), 'utf8')
  const save = src.indexOf('writePrivateJson(')
  assert.ok(save > 0 && save < src.lastIndexOf(`runCrmWinsSwitch(prisma, 'on', true)`), 'saved first')
  assert.doesNotMatch(src, /console\.log\([^)]*copy\.rows\b(?!\.length)/, 'only the count of rows is printed')
  assert.match(src, /if \(!APPLY\) \{\s+console\.log\('Dry run: nothing changed\. Add --apply to turn the switch off/)
})

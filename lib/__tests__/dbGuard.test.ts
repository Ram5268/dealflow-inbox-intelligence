// Brief 41 (H11) — the live-database guard for DealFlow's database-backed tests,
// and the split that keeps them out of `npm test`. Brief 41.2 (PR B): the guards
// every script uses (scriptGuards.test.ts checks they do). Pure: no DB, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  APPLY_FLAG, DRY_RUN_FLAG, LIVE_OVERRIDE_FLAG, applyRequested, assertTestDatabase, databaseName, isTestDatabase,
  maintenanceApply, refuseLiveDatabase, refuseRemoteServer, scriptArgs,
} from '../dbGuard'
import { INTEGRATION_TESTS } from './integrationTests'

const ROOT = join(__dirname, '..', '..')
const LIVE = 'postgresql://u:p@db.example.com:5432/railway?sslmode=require'
const PERF = 'postgresql://u:p@db.example.com:5432/dealflow_perf'
const TEST = 'postgres://u:p@localhost/dealflow_test'

test('only *_perf and *_test databases count as test databases', () => {
  assert.equal(databaseName(LIVE), 'railway')
  assert.equal(databaseName(undefined), null)
  assert.equal(databaseName('not a url'), null)
  assert.equal(isTestDatabase(PERF), true)
  assert.equal(isTestDatabase(TEST), true)
  assert.equal(isTestDatabase(LIVE), false)
  assert.equal(isTestDatabase('postgresql://u:p@h/dealflow_test_backup'), false)
  assert.equal(isTestDatabase(undefined), false)
  // Only postgres URLs: a socket URL's path isn't the database it connects to.
  assert.equal(isTestDatabase('socket:/x_test?db=railway'), false)
})

test('refuses a live or unset database, unless --i-mean-live is passed', () => {
  assert.throws(() => assertTestDatabase(LIVE, 'x', []), /REFUSING: x would use database "railway"/)
  assert.throws(() => assertTestDatabase(undefined, 'x', []), /"\(not set\)"/)
  assert.doesNotThrow(() => assertTestDatabase(PERF, 'x', []))
  assert.doesNotThrow(() => assertTestDatabase(LIVE, 'x', ['node', 'file.ts', LIVE_OVERRIDE_FLAG]))
})

test('Brief 41.2: a database path with a "/" is not one database name, so not a test database', () => {
  assert.equal(databaseName('postgresql://u:p@h/railway/x_test'), null)
  assert.equal(isTestDatabase('postgresql://u:p@h/railway/x_test'), false)
  assert.equal(isTestDatabase('postgresql://u:p@h/railway%2Fx_test'), false)
  assert.equal(databaseName(PERF + '?sslmode=require'), 'dealflow_perf')
})

// A command line as a script sees it.
const run = (...flags: string[]) => ['node', 'scripts/x.ts', ...flags]

test('Brief 41.2: a test or seed script refuses anything but a test database, and no flag changes that', () => {
  assert.doesNotThrow(() => refuseLiveDatabase(PERF, 'x'))
  assert.doesNotThrow(() => refuseLiveDatabase(TEST, 'x'))
  assert.throws(() => refuseLiveDatabase(LIVE, 'scripts/seed-x.ts (DATABASE_URL)'), /^Error: REFUSING: scripts\/seed-x\.ts \(DATABASE_URL\) would use database "railway"/)
  assert.throws(() => refuseLiveDatabase(undefined, 'x'), /"\(not set\)"/)
  assert.throws(() => refuseLiveDatabase('not a url', 'x'), /"\(unreadable URL\)"/)
  assert.throws(() => refuseLiveDatabase('postgresql://u:p@h/railway/x_test', 'x'), /REFUSING/)
  // There is no override: --i-mean-live on the command line doesn't help, and
  // the refusal doesn't mention it.
  const saved = process.argv
  process.argv = run(LIVE_OVERRIDE_FLAG, APPLY_FLAG)
  try {
    assert.throws(() => refuseLiveDatabase(LIVE, 'x'), (e: Error) => /REFUSING/.test(e.message) && !e.message.includes(LIVE_OVERRIDE_FLAG))
  } finally {
    process.argv = saved
  }
})

test('Brief 41.2: a maintenance script is a dry run unless --apply; --apply on a live database also needs --i-mean-live', () => {
  // The default, and the old flags: a dry run (false), on any database.
  assert.equal(maintenanceApply(LIVE, 'x', run()), false)
  assert.equal(maintenanceApply(LIVE, 'x', run(DRY_RUN_FLAG)), false)
  assert.equal(maintenanceApply(LIVE, 'x', run('--confirm')), false)
  assert.equal(maintenanceApply(LIVE, 'x', run(LIVE_OVERRIDE_FLAG)), false)
  assert.equal(maintenanceApply(undefined, 'x', run()), false)
  // --apply writes on a test database.
  assert.equal(maintenanceApply(PERF, 'x', run(APPLY_FLAG)), true)
  assert.equal(maintenanceApply(TEST, 'x', run('200', APPLY_FLAG)), true)
  // --apply on anything else is refused before anything runs, and says how to go on.
  assert.throws(
    () => maintenanceApply(LIVE, 'scripts/x.ts (DATABASE_URL)', run(APPLY_FLAG)),
    /^Error: REFUSING: scripts\/x\.ts \(DATABASE_URL\) --apply would write to database "railway".*--i-mean-live/,
  )
  // ...unless --i-mean-live is given too, anywhere on the line.
  assert.equal(maintenanceApply(LIVE, 'x', run(APPLY_FLAG, LIVE_OVERRIDE_FLAG)), true)
  assert.equal(maintenanceApply(LIVE, 'x', run(LIVE_OVERRIDE_FLAG, '--limit', '5', APPLY_FLAG)), true)
  // A dry-run flag always wins.
  assert.equal(maintenanceApply(LIVE, 'x', run(APPLY_FLAG, DRY_RUN_FLAG, LIVE_OVERRIDE_FLAG)), false)
  // Writing needs a database name it can read, even with the override.
  assert.throws(() => maintenanceApply(undefined, 'x', run(APPLY_FLAG, LIVE_OVERRIDE_FLAG)), /--apply needs a database URL it can read; got "\(not set\)"/)
  assert.throws(() => maintenanceApply('nonsense', 'x', run(APPLY_FLAG, LIVE_OVERRIDE_FLAG)), /"\(unreadable URL\)"/)
  assert.throws(() => maintenanceApply('postgresql://u:p@h/railway/x_test', 'x', run(APPLY_FLAG, LIVE_OVERRIDE_FLAG)), /REFUSING/)
  // Flags are exact words.
  assert.equal(maintenanceApply(PERF, 'x', run('--apply=true')), false)
  assert.equal(maintenanceApply(PERF, 'x', run('--APPLY')), false)
  assert.throws(() => maintenanceApply(LIVE, 'x', run(APPLY_FLAG, '--i-mean-live=yes')), /REFUSING/)
  assert.equal(applyRequested(run(APPLY_FLAG)), true)
  assert.equal(applyRequested(run(APPLY_FLAG, DRY_RUN_FLAG)), false)
})

test('Brief 41.2: scriptArgs drops the guard flags, wherever they are', () => {
  assert.deepEqual(scriptArgs(run(APPLY_FLAG, '200')), ['200'])
  assert.deepEqual(scriptArgs(run('200', LIVE_OVERRIDE_FLAG, APPLY_FLAG)), ['200'])
  assert.deepEqual(scriptArgs(run(DRY_RUN_FLAG)), [])
  assert.deepEqual(scriptArgs(run('--limit', '5')), ['--limit', '5'])
})

test('Brief 41.2: a chat harness only talks to a dev server on this machine', () => {
  for (const url of ['http://localhost:3002/api/chat', 'http://127.0.0.1:3000', 'http://[::1]:3000/api/chat', 'https://localhost']) {
    assert.doesNotThrow(() => refuseRemoteServer(url, 'x'), url)
  }
  for (const url of [
    'https://dealflow-inbox-intelligence.vercel.app/api/chat', 'http://localhost.example.com/api/chat',
    'http://10.0.0.5:3000', 'ftp://localhost/x', 'nonsense', '', undefined,
  ]) {
    assert.throws(() => refuseRemoteServer(url, 'scripts/x.ts (CHAT_URL)'), /^Error: REFUSING: scripts\/x\.ts \(CHAT_URL\) /, String(url))
  }
})

const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>
const npmTestFiles = [...new Set(
  Object.entries(scripts)
    .filter(([name]) => name !== 'test:integration')
    .flatMap(([, cmd]) => cmd.match(/[A-Za-z0-9_/.[\]-]+\.test\.tsx?/g) ?? []),
)]

test('npm test runs no database-backed file', () => {
  const integration = new Set(INTEGRATION_TESTS.map(t => t.file))
  for (const f of npmTestFiles) {
    assert.ok(!integration.has(f), `${f} is an integration test`)
    const src = readFileSync(join(ROOT, f), 'utf8')
    assert.doesNotMatch(src, /^import '[^']*(dotenv\/config|requireTestDb)'/m, `${f} loads .env or the DB guard`)
  }
  // The pure tests that only import database modules stay in npm test.
  for (const f of [
    'lib/chat/tools/__tests__/searchParties.test.ts',
    'app/api/instantly/enroll/__tests__/killSwitch.test.ts',
    'app/api/matches/__tests__/byId.test.ts',
    'lib/crm-sync/__tests__/roClient.test.ts',
    'lib/ranking/__tests__/queueScope.test.ts',
    'lib/__tests__/nightlyPipeline.test.ts',
  ]) assert.ok(npmTestFiles.includes(f), `${f} must stay in npm test`)
})

test('npm run test:integration runs every database-backed file, each guarded first', () => {
  assert.equal(scripts['test:integration'], 'npx --yes tsx scripts/test-integration.ts')
  for (const { file } of INTEGRATION_TESTS) {
    assert.ok(existsSync(join(ROOT, file)), file)
    const firstImport = readFileSync(join(ROOT, file), 'utf8').split('\n').find(l => l.startsWith('import '))
    assert.match(firstImport ?? '', /^import '(\.\.\/)+__tests__\/requireTestDb'$/, file)
  }
  const runner = readFileSync(join(ROOT, 'scripts/test-integration.ts'), 'utf8')
  const guard = runner.indexOf('refuseLiveDatabase(')
  assert.ok(guard >= 0 && guard < runner.indexOf('spawnSync('), 'the runner checks before running anything')
})

test('Brief 41.2: the integration tests have no live override, in the runner or in each file', () => {
  // They insert and delete [TEST_*] rows: test-only (class 1), like the CRM's tests.
  const runner = readFileSync(join(ROOT, 'scripts/test-integration.ts'), 'utf8')
  assert.doesNotMatch(runner, /assertTestDatabase|LIVE_OVERRIDE_FLAG|--i-mean-live/)
  const perFile = readFileSync(join(ROOT, 'lib/__tests__/requireTestDb.ts'), 'utf8')
  assert.match(perFile, /^refuseLiveDatabase\(process\.env\.DATABASE_URL, /m)
  assert.doesNotMatch(perFile, /assertTestDatabase/)
})

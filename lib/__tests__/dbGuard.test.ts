// Brief 41 (H11) — the live-database guard for DealFlow's database-backed tests,
// and the split that keeps them out of `npm test`. Pure: no DB, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { assertTestDatabase, databaseName, isTestDatabase, LIVE_OVERRIDE_FLAG } from '../dbGuard'
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
  assert.ok(runner.indexOf('assertTestDatabase(') < runner.indexOf('spawnSync('), 'the runner checks before running anything')
})

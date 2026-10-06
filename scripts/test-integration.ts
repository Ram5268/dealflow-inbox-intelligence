// Brief 41 (H11) — `npm run test:integration`: the database-backed test files,
// kept out of `npm test`. Refuses unless DATABASE_URL is a *_perf / *_test
// database; `npm run test:integration -- --i-mean-live` runs them against the
// configured database on purpose (they insert and delete [TEST_*] rows).
import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { assertTestDatabase, LIVE_OVERRIDE_FLAG } from '../lib/dbGuard'
import { INTEGRATION_TESTS } from '../lib/__tests__/integrationTests'

try {
  assertTestDatabase(process.env.DATABASE_URL, 'npm run test:integration (DATABASE_URL)')
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}

const override = process.argv.includes(LIVE_OVERRIDE_FLAG) ? [LIVE_OVERRIDE_FLAG] : []
const failed: string[] = []
for (const { file, runner } of INTEGRATION_TESTS) {
  const [cmd, args] =
    runner === 'tsx'
      ? ['npx', ['--yes', 'tsx', file, ...override]]
      : ['node_modules/.bin/ts-node', ['--compiler-options', '{"module":"CommonJS"}', file, ...override]]
  console.log(`\n▶ ${file}`)
  if (spawnSync(cmd, args, { stdio: 'inherit' }).status !== 0) failed.push(file)
}
if (failed.length) {
  console.error(`\n${failed.length} integration test file(s) failed:\n${failed.join('\n')}`)
  process.exit(1)
}
console.log(`\nAll ${INTEGRATION_TESTS.length} integration test files passed.`)

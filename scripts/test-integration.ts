// Brief 41 (H11) — `npm run test:integration`: the database-backed test files,
// kept out of `npm test`. Refuses unless DATABASE_URL is a *_perf / *_test
// database. Brief 41.2 (PR B, engineering precaution): no live override any
// more. They are tests that insert and delete [TEST_*] rows, and nothing needs
// them on production; each file refuses on its own too (requireTestDb).
import 'dotenv/config'
import { spawnSync } from 'node:child_process'
import { refuseLiveDatabase } from '../lib/dbGuard'
import { INTEGRATION_TESTS } from '../lib/__tests__/integrationTests'

try {
  refuseLiveDatabase(process.env.DATABASE_URL, 'npm run test:integration (DATABASE_URL)')
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}

const failed: string[] = []
for (const { file, runner } of INTEGRATION_TESTS) {
  const [cmd, args] =
    runner === 'tsx'
      ? ['npx', ['--yes', 'tsx', file]]
      : ['node_modules/.bin/ts-node', ['--compiler-options', '{"module":"CommonJS"}', file]]
  console.log(`\n▶ ${file}`)
  if (spawnSync(cmd, args, { stdio: 'inherit' }).status !== 0) failed.push(file)
}
if (failed.length) {
  console.error(`\n${failed.length} integration test file(s) failed:\n${failed.join('\n')}`)
  process.exit(1)
}
console.log(`\nAll ${INTEGRATION_TESTS.length} integration test files passed.`)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { INTEGRATION_TESTS } from './integrationTests'

// Brief 43 (PR 0, engineering precaution): `npm run test:unit` (part of
// `npm test`) runs every file named `*.unit.test.ts` under lib/, app/ and
// components/ with node's test runner under tsx, so a new database-free test
// file needs no edit to package.json's one-line `test` chain (Brief 43 adds
// about 18 PRs, merged one at a time). `npm test` must never touch a database
// (Brief 41, #21), so a `.unit.test.ts` file may not be a database test.

const ROOT = join(__dirname, '..', '..')

function unitTestFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.unit.test.ts')) out.push(relative(ROOT, path))
    }
  }
  for (const top of ['lib', 'app', 'components']) walk(join(ROOT, top))
  return out.sort()
}

test('the runner finds this file', () => {
  assert.ok(unitTestFiles().includes(join('lib', '__tests__', 'unitTestRunner.unit.test.ts')))
})

test('no .unit.test.ts file is a database test', () => {
  const integration = new Set(INTEGRATION_TESTS.map(t => t.file))
  for (const file of unitTestFiles()) {
    assert.ok(!file.includes('.integration.'), `${file}: integration tests run in npm run test:integration`)
    assert.ok(!integration.has(file), `${file} is listed in INTEGRATION_TESTS`)
    if (file === relative(ROOT, __filename)) continue // this file names the patterns
    const src = readFileSync(join(ROOT, file), 'utf8')
    assert.ok(!/requireTestDb|\bdotenv\b/.test(src), `${file} loads a database (requireTestDb / dotenv)`)
  }
})

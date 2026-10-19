// Brief 49 (PR 4; Ryan's open item 5.3): pins which code may read DealFlow's own home values.
//
// Ryan's rule (2026-10-17): our value estimates stay out of anything a buyer or homeowner
// sees. They live in the PropertyValuation table, and today only the monthly job's import
// address, the matching switch and Ryan's own CRM card read them. This test fails when any
// other file starts mentioning that table (`propertyValuation` / `PropertyValuation`), or
// calls the two functions that hand the values out, so a new reader can't slip in unnoticed.
//
// Test code is not scanned: it never runs in production and never reaches a buyer or
// homeowner. Markdown docs aren't scanned either.
//
// To add a reader: first check it serves only Ryan's own screens or matching, and get Ryan's
// yes. Then add the file below with a one-line reason.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// The repo's top folder (also right in a git worktree), whatever folder the test runs from.
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

// Built from `git grep -il property_valuation` on 2026-10-19 (main 9cfcb72), plus the folders
// and files Brief 49 names.
const ALLOWED: Array<[RegExp, string]> = [
  [/^prisma\/schema\.prisma$/, 'the table definition'],
  [/^prisma\/migrations\//, "the tables' migrations"],
  [/^lib\/valuations\//, 'the import, targets and status addresses (Brief 44)'],
  [/^app\/api\/valuations\//, 'the import, targets and status routes (Brief 44)'],
  [/^lib\/matching\/ourEstimates\.ts$/, 'matching behind the USE_OUR_ESTIMATES switch (Brief 44 PR 4)'],
  [/^lib\/matching\/ourEstimatesPreview\.ts$/, "the switch's read-only preview (Brief 44 PR 4)"],
  [/^lib\/matching\/nightly\/runScoring\.ts$/, "the nightly's database type: it hands the table to ourEstimates.ts"],
  [/^scripts\/valuation-[^/]+$/, 'the guarded valuation scripts (Brief 44)'],
  [/^valuation\//, 'the monthly job that computes the values (Brief 44)'],
  [/^lib\/chat\/valuation\.ts$/, 'Drift shows Ryan our estimate, labeled internal (Brief 43 PR 12, Ryan\'s D9)'],
]

// The functions in lib/matching/ourEstimates.ts that return the values themselves.
const VALUE_FUNCTIONS = /\b(loadPublishedValues|newestPublishedValues)\b/
const VALUE_FUNCTION_USERS: RegExp[] = [/^lib\/matching\/ourEstimates\.ts$/, /^scripts\/valuation-[^/]+$/]

const MENTION = /property_?valuation/i
const isTest = (f: string) => /(^|\/)__tests__\//.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /^test\//.test(f)
const isDoc = (f: string) => /\.md$/i.test(f)

function sourceFiles(): string[] {
  // Tracked files plus new ones not yet committed (ignored files such as node_modules stay out).
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\0').filter(f => f && !isTest(f) && !isDoc(f))
}

function read(f: string): string | null {
  const buf = readFileSync(path.join(ROOT, f))
  return buf.includes(0) ? null : buf.toString('utf8') // skip binary files (images, PDFs)
}

const RULE = "Ryan's rule (2026-10-17): our value estimates stay out of anything a buyer or homeowner sees"

test('only the allowed files mention the PropertyValuation table', () => {
  const files = sourceFiles()
  assert.ok(files.length > 100, `git ls-files found only ${files.length} files: run this from the repo`)
  const readers = files.filter(f => MENTION.test(read(f) ?? ''))
  const strangers = readers.filter(f => !ALLOWED.some(([re]) => re.test(f)))
  assert.deepEqual(strangers, [],
    `${RULE}. These files read or name the PropertyValuation table but aren't on the allowed list in ` +
    `lib/valuations/__tests__/readers.unit.test.ts: ${strangers.join(', ')}. If one only serves Ryan's own ` +
    'screens or matching, add it to ALLOWED with a one-line reason, after Ryan agrees.')
  // Today's readers are still found, so the scan itself works.
  for (const f of ['prisma/schema.prisma', 'lib/valuations/targets.ts', 'lib/valuations/importRun.ts', 'lib/matching/ourEstimates.ts', 'lib/matching/nightly/runScoring.ts']) {
    assert.ok(readers.includes(f), `the scan should find ${f}`)
  }
})

test('only the allowed files call the functions that hand out the values', () => {
  const users = sourceFiles().filter(f => /\.[cm]?[jt]sx?$/.test(f) && VALUE_FUNCTIONS.test(read(f) ?? ''))
  const strangers = users.filter(f => !VALUE_FUNCTION_USERS.some(re => re.test(f)))
  assert.deepEqual(strangers, [],
    `${RULE}. These files call loadPublishedValues or newestPublishedValues (lib/matching/ourEstimates.ts) but ` +
    `aren't on the allowed list in lib/valuations/__tests__/readers.unit.test.ts: ${strangers.join(', ')}.`)
  assert.ok(users.includes('lib/matching/ourEstimates.ts'), 'the scan should find ourEstimates.ts')
})

test('the scan sees a new reader, and skips tests and docs', () => {
  const allowed = (f: string) => ALLOWED.some(([re]) => re.test(f))
  for (const f of ['app/api/matches/route.ts', 'lib/reports/buyerMatch.ts', 'lib/chat/tools/findSeller.ts', 'components/MatchCard.tsx',
    'lib/valuationsExtra.ts', 'scripts/export-valuations.ts', 'lib/chat/valuation.tsx']) {
    assert.equal(allowed(f), false, f)
  }
  for (const f of ['lib/valuations/status.ts', 'app/api/valuations/status/route.ts', 'scripts/valuation-switch.ts', 'lib/chat/valuation.ts']) {
    assert.equal(allowed(f), true, f)
  }
  for (const f of ['lib/__tests__/memoryDb.ts', 'lib/chat/foo.test.ts', 'app/x/y.unit.test.ts', 'lib/a.spec.tsx', 'test/fixtures/x.json']) {
    assert.equal(isTest(f), true, f)
  }
  assert.equal(isTest('lib/testing/helper.ts'), false)
  assert.equal(isDoc('README.md'), true)
  assert.equal(MENTION.test('db.propertyValuation.findMany'), true)
  assert.equal(MENTION.test('SELECT * FROM "PropertyValuation"'), true)
  assert.equal(MENTION.test('property_valuation'), true)
  assert.equal(MENTION.test('Property Valuation and Assessment Data'), false) // the city's dataset title, not our table
})

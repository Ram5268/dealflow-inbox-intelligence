// Brief 49 (PR 4; Ryan's open item 5.3): pins which code may read DealFlow's own home values.
//
// Ryan's rule (2026-10-17): our value estimates stay out of anything a buyer or homeowner
// sees. They live in the PropertyValuation table, and today only the monthly job's import
// address, the matching switch and Ryan's own CRM card read them. This test fails when any
// other file starts mentioning that table (`propertyValuation` / `PropertyValuation`, or the
// `valuations` relation that reaches it from MojoContact and ValuationRun), or calls the
// functions that hand the values out, so a new reader can't slip in unnoticed.
//
// Test code is not scanned: it never runs in production and never reaches a buyer or
// homeowner. Markdown docs aren't scanned either.
//
// To add a reader: first check it serves only Ryan's own screens or matching, and get Ryan's
// yes. Then add the file below with a one-line reason.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// The repo's top folder (also right in a git worktree), whatever folder the test runs from.
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

// Built from `git grep -il property_valuation` on 2026-10-19 (main 9cfcb72), plus the files
// Brief 49 names. Exact files where a folder could later hold a buyer-facing page or route.
const ALLOWED: Array<[RegExp, string]> = [
  [/^prisma\/schema\.prisma$/, 'the table definition'],
  [/^prisma\/migrations\//, "the tables' migrations"],
  [/^lib\/valuations\/(importRun|targets)\.ts$/, 'the import and the targets address (Brief 44)'],
  [/^app\/api\/valuations\/(import|status|targets)\/route\.ts$/, 'the import, targets and status routes (Brief 44)'],
  [/^lib\/matching\/ourEstimates\.ts$/, 'matching behind the USE_OUR_ESTIMATES switch (Brief 44 PR 4)'],
  [/^lib\/matching\/ourEstimatesPreview\.ts$/, "the switch's read-only preview (Brief 44 PR 4)"],
  [/^lib\/matching\/nightly\/runScoring\.ts$/, "the nightly's database type: it hands the table to ourEstimates.ts"],
  [/^scripts\/valuation-[^/]+$/, 'the guarded valuation scripts (Brief 44)'],
  [/^valuation\//, 'the monthly job that computes the values (Brief 44)'],
  [/^lib\/chat\/valuation\.ts$/, 'Drift shows Ryan our estimate, labeled internal (Brief 43 PR 12, Ryan\'s D9)'],
]

// The functions that return the values, or listings priced by them: loadPublishedValues,
// newestPublishedValues and withOurEstimates (lib/matching/ourEstimates.ts), and
// loadScoringInputs (lib/matching/nightly/runScoring.ts), whose listings carry our value as
// their price when the switch is on. Matched as a call or an import, not a mention in a comment.
const VALUE_FUNCTIONS = /\b(loadPublishedValues|newestPublishedValues|withOurEstimates|loadScoringInputs)\b\s*(\(|,|\}|as\b)/
const VALUE_FUNCTION_USERS: Array<[RegExp, string]> = [
  [/^lib\/matching\/ourEstimates\.ts$/, 'where they live'],
  [/^lib\/matching\/nightly\/runScoring\.ts$/, 'the nightly scoring (matching only)'],
  [/^lib\/importScoring\/steps\.ts$/, 'scoring CRM-uploaded sellers, as the nightly does (Brief 45; matching only)'],
  [/^scripts\/valuation-[^/]+$/, 'the guarded valuation scripts (Brief 44)'],
  [/^lib\/chat\/valuation\.ts$/, 'Drift shows Ryan our estimate, labeled internal (Brief 43 PR 12, Ryan\'s D9)'],
]

const MENTION = /property_?valuation/i
// Prisma's relation fields reach the same rows without naming the table:
// mojoContact.findMany({ include: { valuations: true } }), valuationRun.findFirst({ select: { valuations: ... } }).
const RELATION = /\bvaluations\s*:/
const mentions = (s: string) => MENTION.test(s) || RELATION.test(s)
const isTest = (f: string) => /(^|\/)__tests__\//.test(f) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || /^test\//.test(f)
const isDoc = (f: string) => /\.md$/i.test(f)

function sourceFiles(): string[] {
  // Tracked files plus new ones not yet committed (ignored files such as node_modules stay out).
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\0').filter(f => f && !f.endsWith('/') && !isTest(f) && !isDoc(f))
}

function read(f: string): string | null {
  const p = path.join(ROOT, f)
  try {
    if (!statSync(p).isFile()) return null // a nested repo or worktree, which git lists as a folder
    const buf = readFileSync(p)
    return buf.includes(0) ? null : buf.toString('utf8') // skip binary files (images, PDFs)
  } catch {
    return null // deleted locally but not yet committed
  }
}

const RULE = "Ryan's rule (2026-10-17): our value estimates stay out of anything a buyer or homeowner sees"

test('only the allowed files mention the PropertyValuation table', () => {
  const files = sourceFiles()
  assert.ok(files.length > 100, `git ls-files found only ${files.length} files: run this from the repo`)
  const readers = files.filter(f => mentions(read(f) ?? ''))
  const strangers = readers.filter(f => !ALLOWED.some(([re]) => re.test(f)))
  assert.deepEqual(strangers, [],
    `${RULE}. These files read or name the PropertyValuation table (or its \`valuations\` relation) but aren't on ` +
    `the allowed list in lib/valuations/__tests__/readers.unit.test.ts: ${strangers.join(', ')}. If one only serves ` +
    "Ryan's own screens or matching, add it to ALLOWED with a one-line reason, after Ryan agrees.")
  // Today's readers are still found, so the scan itself works.
  for (const f of ['prisma/schema.prisma', 'lib/valuations/targets.ts', 'lib/valuations/importRun.ts', 'lib/matching/ourEstimates.ts', 'lib/matching/nightly/runScoring.ts']) {
    assert.ok(readers.includes(f), `the scan should find ${f}`)
  }
})

test('only the allowed files call the functions that hand out the values', () => {
  const users = sourceFiles().filter(f => /\.[cm]?[jt]sx?$/.test(f) && VALUE_FUNCTIONS.test(read(f) ?? ''))
  const strangers = users.filter(f => !VALUE_FUNCTION_USERS.some(([re]) => re.test(f)))
  assert.deepEqual(strangers, [],
    `${RULE}. These files call loadPublishedValues, newestPublishedValues or withOurEstimates ` +
    '(lib/matching/ourEstimates.ts), or loadScoringInputs (lib/matching/nightly/runScoring.ts, whose listings carry ' +
    `our values as their price), but aren't on the allowed list in lib/valuations/__tests__/readers.unit.test.ts: ` +
    `${strangers.join(', ')}. If one only serves Ryan's own screens or matching, add it to VALUE_FUNCTION_USERS ` +
    'with a one-line reason, after Ryan agrees.')
  for (const f of ['lib/matching/ourEstimates.ts', 'lib/matching/nightly/runScoring.ts', 'lib/importScoring/steps.ts']) {
    assert.ok(users.includes(f), `the scan should find ${f}`)
  }
})

test('the scan sees a new reader, and skips tests and docs', () => {
  const allowed = (f: string) => ALLOWED.some(([re]) => re.test(f))
  for (const f of ['app/api/matches/route.ts', 'lib/reports/buyerMatch.ts', 'lib/chat/tools/findSeller.ts', 'components/MatchCard.tsx',
    'lib/valuationsExtra.ts', 'scripts/export-valuations.ts', 'lib/chat/valuation.tsx',
    'app/api/valuations/values/route.ts', 'lib/valuations/buyerSummary.ts']) {
    assert.equal(allowed(f), false, f)
  }
  for (const f of ['lib/valuations/targets.ts', 'app/api/valuations/status/route.ts', 'scripts/valuation-switch.ts', 'lib/chat/valuation.ts']) {
    assert.equal(allowed(f), true, f)
  }
  for (const f of ['lib/__tests__/memoryDb.ts', 'lib/chat/foo.test.ts', 'app/x/y.unit.test.ts', 'lib/a.spec.tsx', 'test/fixtures/x.json']) {
    assert.equal(isTest(f), true, f)
  }
  assert.equal(isTest('lib/testing/helper.ts'), false)
  assert.equal(isDoc('README.md'), true)
  assert.equal(mentions('db.propertyValuation.findMany'), true)
  assert.equal(mentions('SELECT * FROM "PropertyValuation"'), true)
  assert.equal(mentions('property_valuation'), true)
  assert.equal(mentions("db.mojoContact.findUnique({ where: { id }, include: { valuations: true } })"), true)
  assert.equal(mentions('Property Valuation and Assessment Data'), false) // the city's dataset title, not our table
  assert.equal(VALUE_FUNCTIONS.test('await withOurEstimates(db, orgId, inputs)'), true)
  assert.equal(VALUE_FUNCTIONS.test("import { MAX_KEPT_PER_SELLER, loadScoringInputs, scoreAll } from '../matching/nightly/runScoring'"), true)
  assert.equal(VALUE_FUNCTIONS.test("import { loadPublishedValues as lp } from '../matching/ourEstimates'"), true)
  assert.equal(VALUE_FUNCTIONS.test('// the nightly scoring pool (runScoring.ts loadScoringInputs: real rows)'), false) // a comment
})

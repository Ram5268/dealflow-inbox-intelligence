// Brief 41.2 (PR B), engineering precaution: every script under scripts/
// refuses the live database unless that's clearly intended.
// Scripts load .env, and the main checkout's .env DATABASE_URL is production.
// DB-free: this test only parses source files.
//
// A script that isn't on READ_ONLY must import a database guard from
// lib/dbGuard and call it at the top level, right after its imports: before
// any function, class, database client use or fetch, so it runs before
// anything can touch a database or a paid API. The lists below are PR B's
// classification; a new script needs no entry here, only a guard (or a
// READ_ONLY entry with its reason).
//
// Scope: every TypeScript and JavaScript file under scripts/, in any subfolder
// (scripts/tests/ today), except scripts/_archive/, which is retired and never
// run (checked below). Brief 44's Python in valuation/ is out of scope; any
// TypeScript (or JavaScript) script added to scripts/ must pass this test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = join(__dirname, '..', '..')

// Class 3: read only, so no guard. Each never writes to any database: no
// Prisma create/update/upsert/delete, no $executeRaw, no INSERT/UPDATE/DELETE
// SQL, no app code that writes, no server that writes.
const READ_ONLY: Record<string, string> = {
  'scripts/mojo-audit.ts': 'Prints the last Zapier ingests and Mojo data-quality counts: SELECT queries, count() and groupBy() only.',
  'scripts/inspect-hotsheet.ts': 'No database: fetches one StreetEasy hotsheet page and saves it to /tmp.',
  'scripts/extractor-fixture-harness.ts': 'Never queries a database: runs the classifier and runExtraction (which writes nothing) on fixture emails, and writes a local JSON report.',
  'scripts/gen-fixture-pdfs.mjs': 'No database or API: writes test PDFs from the fixture JSON.',
}

// Class 1: test or seed only. refuseLiveDatabase: anything but a *_perf /
// *_test database is refused, with no override.
const TEST_ONLY = [
  'scripts/attachments-live-smoke.ts',
  'scripts/clear-test-data.ts',
  'scripts/eval-seed-matches.ts',
  'scripts/hallucination-adversarial-test.ts',
  'scripts/matching-fixture-harness.ts',
  'scripts/regenerate-match-table-brief32.ts',
  'scripts/regenerate-match-table.ts',
  'scripts/reset-seed-active.ts',
  'scripts/seed-brief25-test-data.ts',
  'scripts/seed-brief32-backfill.ts',
  'scripts/seed-brief32-buyers.ts',
  'scripts/seed-brief32-sellers.ts',
  'scripts/seed-brief32-tuning-backfill.ts',
  'scripts/seed-brief33-operational-variance.ts',
  'scripts/seed-stress-cleanup.ts',
  'scripts/seed-stress-common.ts',
  'scripts/seed-stress-inbox-opps.ts',
  'scripts/seed-stress-mojo-buyers.ts',
  'scripts/seed-stress-warm.ts',
  'scripts/seed-tenancy.ts',
  'scripts/seed-tiered-matches.ts',
  'scripts/snapshot-match-tiers.ts',
  'scripts/step4-snapshot-and-invalidate.ts',
  'scripts/step463-prep.ts',
  'scripts/test-call-queue.ts',
  'scripts/test-integration.ts',
  'scripts/tests/08-report-generator.ts',
  'scripts/tests/chat-harness.ts',
  'scripts/verify-drift-instrumentation.ts',
  'scripts/wipe-ai-tables.ts',
]

// The two chat harnesses send prompts to a dev server, which saves the chat
// rows, so they also refuse a server that isn't on this machine.
const LOCAL_SERVER_ONLY = ['scripts/hallucination-adversarial-test.ts', 'scripts/tests/chat-harness.ts']

// Class 2: live maintenance. maintenanceApply: a dry run unless --apply, and
// --apply on a database that isn't *_perf / *_test also needs --i-mean-live.
const MAINTENANCE = [
  'scripts/backfill-attachments.ts',
  'scripts/backfill-hotsheets-local.ts',
  'scripts/backfill-hotsheets.ts',
  'scripts/backfill-property-type.ts',
  'scripts/backfill-se-ids.ts',
  'scripts/backfill-units.ts',
  'scripts/brief41-delete-outlook-token.ts',
  'scripts/brief41-null-ownernames.ts',
  'scripts/brief41-undo-miss-delistings.ts',
  'scripts/brief41-withdraw-old-buyer-reports.ts',
  'scripts/catch-up-sweep.ts',
  'scripts/catchup-v2-extract.ts',
  'scripts/crm-lead-sync.ts',
  'scripts/embed-missing.ts',
  'scripts/enable-new-pipeline.ts',
  'scripts/mojo-hygiene.ts',
  'scripts/nightly-pipeline.ts',
  'scripts/populate-se-ids.ts',
  'scripts/reprocess-v2-extraction.ts',
]

const DB_GUARDS = ['refuseLiveDatabase', 'maintenanceApply', 'assertTestDatabase']
const OVERRIDABLE = ['maintenanceApply', 'assertTestDatabase'] // these accept --i-mean-live

const SCRIPT_FILE = /\.(ts|mts|cts|js|mjs|cjs)$/
function listScripts(dir = 'scripts'): string[] {
  return readdirSync(join(ROOT, dir)).flatMap(name => {
    const path = `${dir}/${name}`
    if (statSync(join(ROOT, path)).isDirectory()) return path === 'scripts/_archive' ? [] : listScripts(path)
    return SCRIPT_FILE.test(name) && !name.endsWith('.d.ts') ? [path] : []
  }).sort()
}

const parsed = new Map<string, ts.SourceFile>()
function parse(f: string): ts.SourceFile {
  if (!parsed.has(f)) {
    const kind = /\.[mc]?js$/.test(f) ? ts.ScriptKind.JS : ts.ScriptKind.TS
    parsed.set(f, ts.createSourceFile(f, readFileSync(join(ROOT, f), 'utf8'), ts.ScriptTarget.Latest, true, kind))
  }
  return parsed.get(f)!
}
// The source with every comment removed (strings kept).
const printer = ts.createPrinter({ removeComments: true })
const code = (f: string) => printer.printFile(parse(f))

// Names imported from lib/dbGuard ('../lib/dbGuard', '../../lib/dbGuard' or
// '@/lib/dbGuard'): imported name → local name.
const GUARD_MODULE = /^(?:(?:\.\.\/)+|@\/)lib\/dbGuard$/
function guardImports(f: string): Map<string, string> {
  const names = new Map<string, string>()
  for (const st of parse(f).statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !GUARD_MODULE.test(st.moduleSpecifier.text)) continue
    const bindings = st.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) names.set((el.propertyName ?? el.name).text, el.name.text)
    }
  }
  return names
}

// Where something that could reach a database or the network first appears:
// a function or class (code that could run before the guard), a use of the
// prisma client, a fetch, or a new database client.
function isFirstUse(n: ts.Node): boolean {
  if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isClassLike(n)) return true
  if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'prisma') return true
  if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'fetch') return true
  return ts.isNewExpression(n) && ts.isIdentifier(n.expression) && ['Pool', 'Client', 'PrismaClient'].includes(n.expression.text)
}

// Source positions of the first call of one of `guards` (by its local name)
// and of the first possible database or network use; -1 when there is none.
function positions(f: string, guards: string[]): { call: number; use: number } {
  const imported = guardImports(f)
  const locals = guards.filter(g => imported.has(g)).map(g => imported.get(g)!)
  const sf = parse(f)
  let call = -1
  let use = -1
  const visit = (n: ts.Node): void => {
    if (call < 0 && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && locals.includes(n.expression.text)) call = n.getStart(sf)
    if (use < 0 && isFirstUse(n)) use = n.getStart(sf)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return { call, use }
}
const calls = (f: string, guards: string[]) => positions(f, guards).call >= 0

// Cheap second check for READ_ONLY: obvious database writes, or a request that
// asks a server to write.
const WRITES = [
  /\.(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\s*\(/,
  /\$executeRaw/,
  /\b(INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\b/,
  /\bUPDATE\s+["\w]+\s+SET\b/,
  /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i,
]

test('every script outside READ_ONLY imports a database guard from lib/dbGuard and calls it right after its imports', () => {
  const problems: string[] = []
  for (const f of listScripts()) {
    if (f in READ_ONLY) continue
    const { call, use } = positions(f, DB_GUARDS)
    if (call < 0) problems.push(`${f}: imports and calls no database guard from lib/dbGuard`)
    else if (use >= 0 && use < call) problems.push(`${f}: call the guard at the top level right after the imports, before any function, class, prisma use or fetch`)
  }
  assert.deepEqual(problems, [])
})

test('the classification names real scripts, once each, and READ_ONLY gives a reason', () => {
  const listed = [...Object.keys(READ_ONLY), ...TEST_ONLY, ...MAINTENANCE]
  for (const f of listed) assert.ok(existsSync(join(ROOT, f)), `${f} is listed but doesn't exist`)
  assert.equal(new Set(listed).size, listed.length, 'a script is listed twice')
  for (const f of LOCAL_SERVER_ONLY) assert.ok(TEST_ONLY.includes(f), f)
  for (const [f, why] of Object.entries(READ_ONLY)) assert.ok(why.trim().length > 20, `${f} needs a one-line reason`)
})

test('READ_ONLY scripts contain no obvious database writes', () => {
  for (const f of Object.keys(READ_ONLY)) {
    const src = code(f)
    for (const re of WRITES) assert.doesNotMatch(src, re, `${f} looks like it writes (${re}): guard it instead`)
  }
})

test('test and seed scripts use refuseLiveDatabase, with no --i-mean-live override', () => {
  for (const f of TEST_ONLY) {
    assert.ok(calls(f, ['refuseLiveDatabase']), `${f} must call refuseLiveDatabase`)
    assert.ok(!calls(f, OVERRIDABLE), `${f} must not use a guard that accepts --i-mean-live`)
    assert.doesNotMatch(code(f), /LIVE_OVERRIDE_FLAG|--i-mean-live/, `${f} must not offer the live override`)
  }
  for (const f of LOCAL_SERVER_ONLY) assert.ok(calls(f, ['refuseRemoteServer']), `${f} must call refuseRemoteServer`)
})

test('live-maintenance scripts use maintenanceApply: a dry run unless --apply', () => {
  for (const f of MAINTENANCE) assert.ok(calls(f, ['maintenanceApply']), `${f} must call maintenanceApply`)
})

test('scripts/_archive/ is never run: not by package.json, CI or another script', () => {
  assert.doesNotMatch(readFileSync(join(ROOT, 'package.json'), 'utf8'), /_archive/)
  for (const wf of readdirSync(join(ROOT, '.github', 'workflows'))) {
    assert.doesNotMatch(readFileSync(join(ROOT, '.github', 'workflows', wf), 'utf8'), /_archive/, wf)
  }
  for (const f of listScripts()) assert.doesNotMatch(code(f), /_archive/, f)
})

// Brief 41.2 (PR B), engineering precaution: every script under scripts/
// refuses the live database unless that's clearly intended.
// Scripts load .env, and the main checkout's .env DATABASE_URL is production.
// DB-free: this test parses source files (and, Brief 47, runs two of them with
// fake URLs that can never connect anywhere).
//
// A script that isn't on READ_ONLY must import a database guard from
// lib/dbGuard and call it at the top level, right after its imports: before
// any function, class, database client use or fetch, so it runs before
// anything can touch a database or a paid API. The call is a statement of its
// own (a top-level try is fine), so no condition can skip it, and it is given
// process.env.DATABASE_URL, the URL lib/prisma uses. The lists below are PR
// B's classification; a new script needs no entry here, only a guard (or a
// READ_ONLY entry with its reason).
//
// Scope: every TypeScript and JavaScript file under scripts/, in any subfolder
// (scripts/tests/ today), except scripts/_archive/, which is retired and never
// run (checked below). Brief 44's Python in valuation/ is out of scope; any
// TypeScript (or JavaScript) script added to scripts/ must pass this test.
//
// Brief 47 (PR 2): also prisma/seed.ts and `npm run db:migrate` (at the end).
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  'scripts/migrate-dev-guard.ts', // Brief 47 (PR 2): run by `npm run db:migrate` before `prisma migrate dev`
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

const DB_GUARDS = ['refuseLiveDatabase', 'maintenanceApply']
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
// The guard call is a statement of its own at the top level (or in a top-level
// try block), so no condition can skip it, and it checks the URL lib/prisma
// uses: process.env.DATABASE_URL.
// A catch that swallows the refusal would defeat the guard.
const rethrowsOrExits = (c?: ts.CatchClause) => !c || /\bthrow\b|process\.exit\(\s*[1-9]/.test(c.block.getText())
function unconditional(n: ts.Node): boolean {
  for (let p = n.parent; p && !ts.isSourceFile(p); n = p, p = p.parent) {
    const ok = ts.isExpressionStatement(p) || ts.isVariableDeclaration(p) || ts.isVariableDeclarationList(p) ||
      ts.isVariableStatement(p) || (ts.isBlock(p) && ts.isTryStatement(p.parent) && p.parent.tryBlock === p) ||
      (ts.isTryStatement(p) && p.tryBlock === n && rethrowsOrExits(p.catchClause))
    if (!ok) return false
  }
  return true
}
const checksDatabaseUrl = (c: ts.CallExpression) => c.arguments[0]?.getText() === 'process.env.DATABASE_URL'

function positions(f: string, guards: string[]): { call: number; use: number; callNode?: ts.CallExpression } {
  const imported = guardImports(f)
  const locals = guards.filter(g => imported.has(g)).map(g => imported.get(g)!)
  const sf = parse(f)
  let call = -1
  let use = -1
  let callNode: ts.CallExpression | undefined
  const visit = (n: ts.Node): void => {
    if (call < 0 && ts.isCallExpression(n) && ts.isIdentifier(n.expression) && locals.includes(n.expression.text)) { call = n.getStart(sf); callNode = n }
    if (use < 0 && isFirstUse(n)) use = n.getStart(sf)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return { call, use, callNode }
}
const calls = (f: string, guards: string[]) => positions(f, guards).call >= 0

// Cheap second check for READ_ONLY: obvious database writes, or a request that
// asks a server to write.
const WRITES = [
  /\.(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\s*\(/,
  /\$executeRaw/,
  /\b(INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\b/i,
  /\bUPDATE\s+["\w.]+(\s+(AS\s+)?\w+)?\s+SET\b/i,
  /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i,
]

test('every script outside READ_ONLY imports a database guard from lib/dbGuard and calls it right after its imports', () => {
  const problems: string[] = []
  for (const f of listScripts()) {
    if (f in READ_ONLY) continue
    const { call, use, callNode } = positions(f, DB_GUARDS)
    if (call < 0) problems.push(`${f}: imports and calls no database guard from lib/dbGuard`)
    else if (use >= 0 && use < call) problems.push(`${f}: call the guard at the top level right after the imports, before any function, class, prisma use or fetch`)
    else if (!unconditional(callNode!)) problems.push(`${f}: call the guard as a statement of its own, not under a condition`)
    else if (!checksDatabaseUrl(callNode!)) problems.push(`${f}: give the guard process.env.DATABASE_URL, the URL lib/prisma uses`)
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

// Brief 47 (PR 2), engineering precaution (Brief 41.2 found-not-fixed;
// confirmed 2026-10-18): two commands outside scripts/ could also reach the
// database in .env, which in the main checkout is production.
//   - `npm run db:seed` and `prisma db seed` (prisma.config.ts migrations.seed)
//     run prisma/seed.ts, which writes demo emails and listings. It calls
//     refuseLiveDatabase like the seed scripts above, with no override.
//   - `npm run db:migrate` runs `prisma migrate dev`, Prisma's development
//     tool, which can offer to reset (erase) the database. It now runs
//     scripts/migrate-dev-guard.ts first, which stops it on anything but a
//     *_perf or *_test database. Production migrations stay
//     `prisma migrate deploy`, run only as a named data step.
const SEED = 'prisma/seed.ts'
const MIGRATE_GUARD = 'scripts/migrate-dev-guard.ts'
const PRISMA_CONFIG = 'prisma.config.ts'
const GUARD_DB = 'prisma migrate dev (npm run db:migrate, DATABASE_URL)'
const GUARD_SHADOW = 'prisma migrate dev (npm run db:migrate, SHADOW_DATABASE_URL)'

const packageJson = () =>
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string>; prisma?: { seed?: string } }

// The first statement is `import 'dotenv/config'`, as in prisma.config.ts:
// .env (in the folder it's run from) is loaded before anything else runs, so
// the guard sees the URL the command really uses.
function loadsDotenvFirst(f: string): boolean {
  const first = parse(f).statements[0]
  return !!first && ts.isImportDeclaration(first) && !first.importClause &&
    ts.isStringLiteral(first.moduleSpecifier) && first.moduleSpecifier.text === 'dotenv/config'
}

test('prisma/seed.ts loads .env, then calls refuseLiveDatabase(process.env.DATABASE_URL) before any database work', () => {
  assert.ok(loadsDotenvFirst(SEED), `${SEED}: the first statement is import 'dotenv/config'`)
  const { call, use, callNode } = positions(SEED, ['refuseLiveDatabase'])
  assert.ok(call >= 0, `${SEED} must import refuseLiveDatabase from lib/dbGuard and call it`)
  assert.ok(use > call, `${SEED}: the guard comes before the pool, the client and any query`)
  assert.ok(unconditional(callNode!), `${SEED}: the guard is a statement of its own, not under a condition`)
  assert.ok(checksDatabaseUrl(callNode!), `${SEED}: the guard is given process.env.DATABASE_URL, the URL its pool uses`)
  assert.ok(!calls(SEED, OVERRIDABLE), `${SEED} must not use a guard that accepts --i-mean-live`)
  assert.doesNotMatch(code(SEED), /LIVE_OVERRIDE_FLAG|--i-mean-live/)
  // Every way to seed runs this file, so its guard covers them all.
  const pkg = packageJson()
  assert.match(pkg.scripts['db:seed'], /\sprisma\/seed\.ts$/)
  assert.match(code(PRISMA_CONFIG), /seed: '[^']*\sprisma\/seed\.ts'/)
  if (pkg.prisma?.seed) assert.match(pkg.prisma.seed, /\sprisma\/seed\.ts$/) // Prisma 7 no longer reads this one
})

test('npm run db:migrate runs the guard first, then prisma migrate dev, which gets any extra arguments', () => {
  const { scripts } = packageJson()
  const steps = scripts['db:migrate'].split(' && ')
  assert.equal(steps.length, 2, 'guard && prisma migrate dev: Prisma runs only when the guard exits 0')
  assert.match(steps[0], /^ts-node .*\sscripts\/migrate-dev-guard\.ts$/)
  // Last, so `npm run db:migrate -- --name x` hands `--name x` to Prisma.
  assert.equal(steps[1], 'prisma migrate dev')
  // No other script runs Prisma's development commands without the guard.
  for (const [name, cmd] of Object.entries(scripts)) {
    if (/\bprisma\s+migrate\s+(dev|reset)\b/.test(cmd)) assert.ok(cmd.startsWith(`${steps[0]} && prisma migrate `), `${name} must run the guard first`)
  }
})

test('the migrate guard checks the URLs prisma.config.ts gives Prisma, with .env loaded the same way', () => {
  for (const f of [MIGRATE_GUARD, PRISMA_CONFIG]) assert.ok(loadsDotenvFirst(f), `${f}: the first statement is import 'dotenv/config'`)
  const config = code(PRISMA_CONFIG)
  assert.match(config, /\burl: process\.env\['DATABASE_URL'\]/)
  assert.match(config, /\bshadowDatabaseUrl: process\.env\['SHADOW_DATABASE_URL'\]/)
  assert.match(code(MIGRATE_GUARD), /refuseLiveDatabase\(process\.env\.SHADOW_DATABASE_URL,/)
})

// Running them the way package.json does (ts-node, CommonJS), with only PATH,
// HOME and TMPDIR from this process, as `env -i` would, from a scratch folder
// outside the repo, so no real .env is ever read. The URLs are fake:
// example.invalid can never resolve, so nothing can connect anywhere. PGHOST
// points there too, so a run with no URL can't fall back to a local server.
const FAKE_LIVE = 'postgresql://u:p@example.invalid:5432/railway'
const FAKE_TEST = 'postgresql://u:p@example.invalid:5432/b47_fake_test'
const FAKE_SHADOW_TEST = 'postgresql://u:p@example.invalid:5432/b47_shadow_test'
const TS_NODE = join(ROOT, 'node_modules', 'ts-node', 'dist', 'bin.js')

const scratchDirs: string[] = []
after(() => { for (const d of scratchDirs) rmSync(d, { recursive: true, force: true }) })
function scratchDir(dotenv?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'b47-db-guard-'))
  scratchDirs.push(dir)
  assert.ok(!dir.startsWith(ROOT), 'the scratch folder is outside the repo')
  if (dotenv !== undefined) writeFileSync(join(dir, '.env'), dotenv)
  return dir
}

type Run = { status: number | null; out: string }
function run(file: string, cwd: string, vars: Record<string, string> = {}): Run {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PGHOST: 'example.invalid', ...vars }
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR
  // No NODE_ENV, as under env -i (Next's types say there always is one).
  const options = { cwd, env: env as NodeJS.ProcessEnv, encoding: 'utf8' as const, timeout: 120_000 }
  const r = spawnSync(process.execPath, [TS_NODE, '--compiler-options', '{"module":"CommonJS"}', join(ROOT, file)], options)
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}` }
}
function assertRefused(r: Run, what: string, database: string): void {
  assert.notEqual(r.status, 0, r.out)
  assert.ok(r.out.includes(`REFUSING: ${what} would use database "${database}"`), r.out)
}

test('the migrate guard refuses a live-looking, unreadable or missing DATABASE_URL and a live-looking shadow database, and passes test databases', () => {
  const dir = scratchDir()
  assertRefused(run(MIGRATE_GUARD, dir, { DATABASE_URL: FAKE_LIVE }), GUARD_DB, 'railway')
  assertRefused(run(MIGRATE_GUARD, dir), GUARD_DB, '(not set)')
  assertRefused(run(MIGRATE_GUARD, dir, { DATABASE_URL: 'not a url' }), GUARD_DB, '(unreadable URL)')
  assertRefused(run(MIGRATE_GUARD, dir, { DATABASE_URL: FAKE_TEST, SHADOW_DATABASE_URL: FAKE_LIVE }), GUARD_SHADOW, 'railway')
  const passes: Record<string, string>[] = [{ DATABASE_URL: FAKE_TEST }, { DATABASE_URL: FAKE_TEST, SHADOW_DATABASE_URL: FAKE_SHADOW_TEST }]
  for (const vars of passes) {
    const r = run(MIGRATE_GUARD, dir, vars)
    assert.equal(r.status, 0, r.out)
    assert.doesNotMatch(r.out, /REFUSING/)
  }
})

test('the seed stops on a live-looking or missing DATABASE_URL before it starts, and goes on for a test database', () => {
  const dir = scratchDir()
  for (const [vars, database] of [[{ DATABASE_URL: FAKE_LIVE }, 'railway'], [{}, '(not set)']] as const) {
    const r = run(SEED, dir, vars)
    assertRefused(r, SEED, database)
    // Stopped before main(): it never started seeding or tried to connect.
    assert.doesNotMatch(r.out, /Seeding demo data|Can't reach database server|P1001|ENOTFOUND/)
  }
  // Past the guard on a test database; example.invalid then can't be reached.
  const r = run(SEED, dir, { DATABASE_URL: FAKE_TEST })
  assert.notEqual(r.status, 0, r.out)
  assert.doesNotMatch(r.out, /REFUSING/)
  assert.match(r.out, /Seeding demo data/)
})

test('the migrate guard and the seed read .env from the folder they are run from, as prisma.config.ts does', () => {
  const live = scratchDir(`DATABASE_URL="${FAKE_LIVE}"\n`)
  // .env is loaded before the seed's guard runs: otherwise it would say "(not set)".
  const seed = run(SEED, live)
  assertRefused(seed, SEED, 'railway')
  assert.doesNotMatch(seed.out, /Seeding demo data/)
  assertRefused(run(MIGRATE_GUARD, live), GUARD_DB, 'railway')
  const fakeTest = run(MIGRATE_GUARD, scratchDir(`DATABASE_URL="${FAKE_TEST}"\n`))
  assert.equal(fakeTest.status, 0, fakeTest.out)
})

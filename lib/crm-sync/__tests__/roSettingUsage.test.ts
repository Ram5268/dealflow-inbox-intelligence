import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Brief 41.2 (PR C, audit M3): DATABASE_URL_CRM_RO, the CRM login, is read only
// in lib/crm-sync/roClient.ts, so every CRM read goes through its one-statement,
// READ ONLY wrapper. Engineering precaution from the Oct 16, 2026 system-map
// review. No database: it only reads source files. It scans every .ts, .tsx,
// .mts, .cts, .js, .jsx, .mjs and .cjs file outside node_modules, .next, .git
// and .vercel; in other runnable or config files (Python, shell, YAML, JSON,
// TOML, SQL) any mention counts as a read. .env files and docs (.md) aren't code.
// A static scan catches mistakes, not deliberate obfuscation: a name built
// from pieces ('DATABASE_URL_' + 'CRM_RO'), an interpolated template, or nested
// or parameter destructuring stay out of its reach.

const ROOT = join(__dirname, '..', '..', '..')
const NAME = 'DATABASE_URL_CRM_RO'
const READER = 'lib/crm-sync/roClient.ts'
const SELF = 'lib/crm-sync/__tests__/roSettingUsage.test.ts' // its examples below mention the name
// Test files allowed to set (and delete) the setting, never to read it.
const SETS_ONLY: Record<string, string> = {
  'lib/crm-sync/__tests__/roClient.test.ts':
    'points crmQuery at a placeholder address (pg is faked, nothing connects) and deletes it afterwards',
  // Brief 45 (PR E): a database-backed test (npm run test:integration only).
  'lib/importScoring/__tests__/scoreImport.integration.test.ts':
    'points crmQuery at the CRM test database it seeds (CRM_TEST_DATABASE_URL, refused unless *_test or *_perf)',
  // Brief 48 (PR 7): the CRM lead copy's database-backed tests (npm run test:integration only).
  'lib/crm-sync/__tests__/crmSyncGolden.integration.test.ts':
    'points crmQuery at the CRM test database it seeds (CRM_TEST_DATABASE_URL, refused unless *_test or *_perf)',
  'lib/crm-sync/__tests__/crmWins.integration.test.ts':
    'points crmQuery at the CRM test database it seeds (CRM_TEST_DATABASE_URL, refused unless *_test or *_perf)',
  'lib/crm-sync/__tests__/crmWinsRestore.integration.test.ts':
    'points crmQuery at the CRM test database it seeds (CRM_TEST_DATABASE_URL, refused unless *_test or *_perf)',
  'lib/crm-sync/__tests__/noMojoId.integration.test.ts': // Brief 48 (PR 8)
    'points crmQuery at the CRM test database it seeds (CRM_TEST_DATABASE_URL, refused unless *_test or *_perf)',
  'lib/crm-sync/__tests__/sellerDetails.integration.test.ts': // Brief 48 (PR 9)
    'points crmQuery at the CRM test database it seeds (CRM_TEST_DATABASE_URL, refused unless *_test or *_perf)',
}
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.vercel'])
const CODE = /\.[cm]?[jt]sx?$/
// No JS-style comments to exempt here, so any mention is a read.
const OTHER = /\.(py|sh|bash|zsh|ya?ml|json|toml|sql)$|^(Dockerfile|Makefile|Procfile)$/

// The ways code can read the setting: a property access (process.env.X,
// process.env?.X, env.X on an alias), a string literal ('X', "X", `X`: covers
// process.env['X'] and a name kept in a variable), and destructuring
// ({ X } = process.env). A plain mention in a comment is fine.
const READS: Array<[string, RegExp]> = [
  ['property access', new RegExp(`(?:\\?\\.|\\.)\\s*${NAME}\\b`, 'g')],
  ['string literal', new RegExp(`(['"\`])${NAME}\\1`, 'g')],
  ['destructuring', new RegExp(`\\{[^{}]*\\b${NAME}\\b[^{}]*\\}\\s*=`, 'g')],
]
const SETS = [
  new RegExp(`\\bdelete\\s+process\\.env\\.${NAME}\\b`, 'g'),
  new RegExp(`\\bprocess\\.env\\.${NAME}\\s*=(?!=)`, 'g'),
]

function readsIn(source: string): Array<{ line: number; form: string }> {
  const hits: Array<{ line: number; form: string }> = []
  for (const [form, re] of READS) {
    for (const m of source.matchAll(re)) hits.push({ line: source.slice(0, m.index).split('\n').length, form })
  }
  return hits.sort((a, b) => a.line - b.line)
}
// Blank out the allowed set/delete forms (same length, so line numbers hold).
const withoutSets = (source: string) => SETS.reduce((s, re) => s.replace(re, m => ' '.repeat(m.length)), source)

function codeFiles(dir = ROOT): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) out.push(...codeFiles(p)) }
    else if (e.isFile() && (CODE.test(e.name) || OTHER.test(e.name))) out.push(relative(ROOT, p).split(sep).join('/'))
  }
  return out
}

test('the detector catches each way of reading the setting', () => {
  for (const s of [
    `const url = process.env.${NAME}`,
    `if (!process.env?.${NAME}) throw new Error('x')`,
    `const url = process.env['${NAME}']`,
    `const url = process.env["${NAME}"]`,
    'const url = process.env[`' + NAME + '`]',
    `const { ${NAME} } = process.env`,
    `const {\n  A,\n  ${NAME}: url,\n} = process.env`,
    `const env = process.env\nconst url = env.${NAME}`,
    `const KEY = '${NAME}'\nconst url = process.env[KEY]`,
    `const prev = process.env.${NAME}`,
  ]) assert.ok(readsIn(withoutSets(s)).length > 0, s)
})

test('a comment mention, another setting, or setting and deleting it are not reads', () => {
  for (const s of [
    `// Set ${NAME} in Vercel; roClient.ts reads it.`,
    `const url = process.env.${NAME}_OTHER`,
    `const other = '${NAME}_OTHER'`,
    `process.env.${NAME} = 'postgres://nobody@127.0.0.1:9/none'`,
    `delete process.env.${NAME}`,
  ]) assert.deepEqual(readsIn(withoutSets(s)), [], s)
  // Setting is allowed only in the plain form: a compare or a ||= reads it.
  assert.ok(readsIn(withoutSets(`if (process.env.${NAME} === 'x') {}`)).length > 0)
  assert.ok(readsIn(withoutSets(`process.env.${NAME} ||= 'x'`)).length > 0)
})

test('only lib/crm-sync/roClient.ts reads DATABASE_URL_CRM_RO', () => {
  const files = codeFiles()
  assert.ok(files.includes(READER) && files.includes(SELF) && files.length > 300, `scanned ${files.length} files`)
  const offenders: string[] = []
  for (const f of files) {
    if (f === READER || f === SELF) continue
    const source = readFileSync(join(ROOT, f), 'utf8')
    if (!source.includes(NAME)) continue
    if (!CODE.test(f)) { offenders.push(`${f} (mentions it)`); continue }
    for (const hit of readsIn(f in SETS_ONLY ? withoutSets(source) : source)) offenders.push(`${f}:${hit.line} (${hit.form})`)
  }
  assert.deepEqual(offenders, [], `Read ${NAME} only in ${READER}; elsewhere go through crmQuery. Found:\n${offenders.join('\n')}`)
})

test('the client still reads it, and every allowed test file still sets it', () => {
  assert.match(readFileSync(join(ROOT, READER), 'utf8'), new RegExp(`process\\.env\\.${NAME}\\b`))
  for (const f of Object.keys(SETS_ONLY)) {
    // A fresh, non-global copy: a /g regex keeps lastIndex between files (Brief 45).
    assert.match(readFileSync(join(ROOT, f), 'utf8'), new RegExp(SETS[1].source), `${f} no longer sets it: drop it from SETS_ONLY`)
  }
})

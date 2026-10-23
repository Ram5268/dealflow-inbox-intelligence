// Brief 48 (PR 16, item 4.14): .env.example says what the code does. It described
// STREETEASY_SYNC_ENABLED backwards, listed a key nothing reads (GOOGLE_MAPS_API_KEY),
// left sync/reprocess-attachments out of the MAINTENANCE_ENABLED list (Brief 48 PR 2
// put it behind the switch), and still called the StreetEasy sweep a scheduled
// CRON_SECRET caller (Brief 48 PR 2 made it by-hand only). Reads files only; no
// database, no network [engineering precaution].
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const ENV = read('.env.example')

// Every file under `dir` (relative to the repo root) whose name passes `keep`.
function walk(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return out
  for (const name of readdirSync(abs)) {
    if (name === 'node_modules' || name === '.next' || name === '.git' || name === '__pycache__') continue
    const rel = join(dir, name)
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, keep, out)
    else if (keep(name)) out.push(rel)
  }
  return out
}

// The comment lines right above `KEY=` (up to the blank line before them).
function commentAbove(key: string): string {
  const lines = ENV.split('\n')
  const at = lines.findIndex(l => l.startsWith(`${key}=`))
  assert.ok(at >= 0, `${key} is in .env.example`)
  const block: string[] = []
  for (let i = at - 1; i >= 0 && lines[i].startsWith('#'); i--) block.unshift(lines[i])
  return block.join('\n')
}

// The route path a route.ts file serves: app/api/sync/run/route.ts -> sync/run.
const routePath = (file: string) => relative(join('app', 'api'), file).split(sep).slice(0, -1).join('/')
const routeFiles = walk(join('app', 'api'), n => n === 'route.ts')

test('STREETEASY_SYNC_ENABLED: .env.example says what lib/streetEasySync.ts does', () => {
  const code = read('lib/streetEasySync.ts')
  const line = ENV.split('\n').find(l => l.startsWith('STREETEASY_SYNC_ENABLED='))
  assert.ok(line, 'STREETEASY_SYNC_ENABLED is listed')
  if (code.includes("process.env.STREETEASY_SYNC_ENABLED !== 'false'")) {
    // On unless exactly 'false' (the default is on, and the planner keeps it on).
    assert.match(line, /on unless exactly 'false'/, line)
    assert.doesNotMatch(line, /'true' enables/, line)
  } else {
    assert.match(code, /process\.env\.STREETEASY_SYNC_ENABLED === 'true'/, 'the switch is read one of the two known ways')
    assert.match(line, /off unless exactly 'true'/, line)
  }
})

test('every key in .env.example is read by the code', () => {
  const keys = [...ENV.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(m => m[1])
  assert.ok(keys.length > 20, `found ${keys.length} keys`)
  const CODE = /\.(ts|tsx|js|mjs|cjs|py|ya?ml|json|prisma|sh|toml)$/
  const files = [
    ...['app', 'lib', 'components', 'scripts', 'prisma', 'valuation', '.github', 'hooks', 'test'].flatMap(d => walk(d, n => CODE.test(n))),
    ...readdirSync(ROOT).filter(n => CODE.test(n) && n !== 'package-lock.json'),
  ].filter(f => !f.endsWith('envExample.unit.test.ts'))
  const text = files.map(f => readFileSync(join(ROOT, f), 'utf8')).join('\n')
  const unread = keys.filter(k => !new RegExp(`\\b${k}\\b`).test(text))
  assert.deepEqual(unread, [], `listed in .env.example but read nowhere: ${unread.join(', ')}`)
})

test('MAINTENANCE_ENABLED: .env.example names every route behind the switch', () => {
  const comment = commentAbove('MAINTENANCE_ENABLED')
  const gated = routeFiles.filter(f => /\bmaintenanceEnabled\(\)/.test(readFileSync(join(ROOT, f), 'utf8'))).map(routePath)
  assert.ok(gated.includes('sync/reprocess-attachments'), `found ${gated.join(', ')}`)
  for (const r of gated) assert.ok(comment.includes(r), `${r} is listed`)
})

test('CRON_SECRET: .env.example names its routes, and only the vercel.json ones as scheduled', () => {
  const comment = commentAbove('CRON_SECRET')
  const users = routeFiles.filter(f => /\bcheckCronBearer\(/.test(readFileSync(join(ROOT, f), 'utf8'))).map(f => `/api/${routePath(f)}`)
  assert.ok(users.includes('/api/se-sync') && users.includes('/api/cron/nightly-pipeline'), users.join(', '))
  for (const r of users) assert.ok(comment.includes(r), `${r} is named`)

  const crons = (JSON.parse(read('vercel.json')).crons as Array<{ path: string }>).map(c => c.path)
  const cut = comment.indexOf('Not scheduled')
  assert.ok(cut > 0, 'the comment says which routes are not scheduled')
  const scheduled = comment.slice(0, cut)
  const notScheduled = comment.slice(cut)
  for (const r of users) {
    if (crons.includes(r)) assert.ok(scheduled.includes(r), `${r} is scheduled in vercel.json`)
    else assert.ok(notScheduled.includes(r) && !scheduled.includes(r), `${r} is not scheduled`)
  }
  // The StreetEasy sweep: GitHub's daily-sweep workflow has no schedule (Brief 48 PR 2).
  assert.doesNotMatch(read('.github/workflows/daily-sweep.yml'), /^\s*schedule:/m)
  assert.match(notScheduled, /by hand/)
  assert.doesNotMatch(scheduled, /StreetEasy/)
})

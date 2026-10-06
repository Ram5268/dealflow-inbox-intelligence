// Brief 41 (H5, H6, L1) — maintenance off-switch, fail-closed admin and cron
// checks, and no StreetEasy side effect when a listing is opened. Pure: no DB,
// no network. Route files are checked by reading their source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { maintenanceEnabled, adminSecretOk } from '../config/maintenance'
import { mapStatus, statusUpdateFor, SE_CHECKABLE_CATEGORIES } from '../streetEasyStatusUpdate'

const ROOT = join(__dirname, '..', '..')
const src = (f: string) => readFileSync(join(ROOT, f), 'utf8')

function withEnv(name: string, value: string | undefined, fn: () => void) {
  const prev = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  try { fn() } finally {
    if (prev === undefined) delete process.env[name]
    else process.env[name] = prev
  }
}

// The first statement of a function body, skipping blank and comment lines.
function firstStatement(source: string, signature: RegExp): string {
  const m = signature.exec(source)
  assert.ok(m, `no ${signature} in source`)
  return source.slice(m.index + m[0].length).split('\n').map(l => l.trim()).find(l => l && !l.startsWith('//')) ?? ''
}
function handlers(source: string): string[] {
  assert.doesNotMatch(source, /export const (GET|POST|PUT|PATCH|DELETE)\b/, 'use export async function handlers')
  return [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map(m => m[1])
}
const firstOf = (source: string, h: string) => firstStatement(source, new RegExp(`export async function ${h}\\b[\\s\\S]*?\\)\\s*\\{\\s*\\n`))

test('MAINTENANCE_ENABLED: off unless exactly "true"', () => {
  for (const v of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'true ']) {
    withEnv('MAINTENANCE_ENABLED', v, () => assert.equal(maintenanceEnabled(), false, JSON.stringify(v)))
  }
  withEnv('MAINTENANCE_ENABLED', 'true', () => assert.equal(maintenanceEnabled(), true))
})

test('ADMIN_SECRET fails closed: unset or empty lets nothing through (was: everything)', () => {
  assert.equal(adminSecretOk(undefined, undefined), false)
  assert.equal(adminSecretOk('anything', undefined), false)
  assert.equal(adminSecretOk('', ''), false)
  assert.equal(adminSecretOk(undefined, 's3'), false)
  assert.equal(adminSecretOk('s3 ', 's3'), false)
  assert.equal(adminSecretOk(['s3'], 's3'), false)
  assert.equal(adminSecretOk('s3', 's3'), true)
})

const MAINTENANCE_ROUTES = [
  'app/api/sync/reextract/route.ts',
  'app/api/sync/reclassify/route.ts',
  'app/api/sync/hotsheet/route.ts',
  'app/api/sync/embed-all/route.ts',
  'app/api/admin/backfill-hotsheets/route.ts',
]

test('every maintenance route checks the switch before anything else', () => {
  for (const f of MAINTENANCE_ROUTES) {
    const s = src(f)
    const hs = handlers(s)
    assert.ok(hs.length > 0, f)
    for (const h of hs) {
      assert.match(firstOf(s, h), /^if \(!maintenanceEnabled\(\)\) return NextResponse\.json\(MAINTENANCE_OFF_BODY, \{ status: 403 \}\)/, `${f} ${h}`)
    }
  }
  assert.match(src('app/api/admin/backfill-hotsheets/route.ts'), /if \(!adminSecretOk\(body\.secret, process\.env\.ADMIN_SECRET\)\)/)
})

test('reextract extracts first, then swaps the listings in one transaction', () => {
  const s = src('app/api/sync/reextract/route.ts')
  const extract = s.indexOf('await classifyAndExtractEmail(')
  const tx = s.indexOf('await prisma.$transaction([')
  const del = s.indexOf('extractedOpportunity.deleteMany(')
  assert.ok(extract > 0 && tx > extract, 'extraction happens before the transaction')
  assert.ok(del > tx, 'the old listings are deleted only inside the transaction')
  assert.equal(s.split('extractedOpportunity.deleteMany(').length - 1, 1, 'no other delete')
  assert.doesNotMatch(s.slice(0, tx), /extractedOpportunity\.create\(/, 'nothing is created outside the transaction')
  // An answer with no entries keeps the old listings (Brief 41 review).
  const empty = s.indexOf('if (results.length === 0) throw')
  assert.ok(empty > extract && empty < tx, 'an empty extraction is refused before the swap')
})

const CRON_ROUTES: Array<[string, string[]]> = [
  ['app/api/push/digest/route.ts', ['GET', 'POST']],
  ['app/api/se-sync/route.ts', ['POST']],
  ['app/api/cron/nightly-pipeline/route.ts', ['GET']],
]

test('cron routes use checkCronBearer (fails closed) and never accept ?secret=', () => {
  for (const [f, expected] of CRON_ROUTES) {
    const s = src(f)
    assert.deepEqual(handlers(s), expected, f)
    assert.match(s, /checkCronBearer\(req\.headers\.get\('authorization'\), process\.env\.CRON_SECRET\)/, f)
    assert.doesNotMatch(s, /searchParams\.get\(['"]secret['"]\)/, f)
  }
  // push/digest: both handlers go through run(), which checks first.
  assert.match(firstStatement(src('app/api/push/digest/route.ts'), /async function run\(req: NextRequest\) \{\s*\n/), /^const auth = checkCronBearer\(/)
})

test('sync/run: the scheduler GET needs the cron secret; Check In (POST) stays open', () => {
  const s = src('app/api/sync/run/route.ts')
  assert.deepEqual(handlers(s), ['POST', 'GET'])
  assert.match(firstOf(s, 'GET'), /^const auth = checkCronBearer\(req\.headers\.get\('authorization'\), process\.env\.CRON_SECRET\)/)
  assert.match(firstOf(s, 'POST'), /^return runSync\(\)/)
  assert.doesNotMatch(s, /searchParams\.get\('secret'\)/)
  // Check In on the home page is a plain POST with no secret: it must keep working.
  assert.match(src('app/page.tsx'), /fetch\('\/api\/sync\/run', \{ method: 'POST' \}\)/)
  // The scheduled callers send the header.
  assert.match(src('.github/workflows/daily-sweep.yml'), /-H "Authorization: Bearer \$\{\{ secrets\.CRON_SECRET \}\}"[\s\S]*\/api\/se-sync/)
  assert.deepEqual(JSON.parse(src('vercel.json')).crons.map((c: { path: string }) => c.path).sort(), ['/api/cron/nightly-pipeline', '/api/push/digest'])
})

test('opening a listing never runs a StreetEasy lookup; the lookup is an explicit POST', () => {
  const get = src('app/api/opportunities/[id]/route.ts')
  assert.deepEqual(handlers(get), ['GET'])
  assert.doesNotMatch(get, /streetEasySync|syncOpportunityStatus|\.update\(|\.upsert\(|\.create\(|\.delete/)
  const lookup = src('app/api/opportunities/[id]/streeteasy/route.ts')
  assert.deepEqual(handlers(lookup), ['POST'])
  assert.match(lookup, /syncOpportunityStatus\(id\)/)
  // Same categories as the lookup itself, and a time limit for a 17-call miss.
  assert.match(lookup, /SE_CHECKABLE_CATEGORIES\.has\(before\.category\)/)
  assert.match(lookup, /export const maxDuration = 60/)
  assert.match(src('app/opportunities/[id]/page.tsx'), /SE_CHECKABLE_CATEGORIES\.has\(opp\.category\)/)
  assert.match(src('app/opportunities/[id]/page.tsx'), /fetch\(`\/api\/opportunities\/\$\{id\}\/streeteasy`, \{ method: 'POST' \}\)/)
})

test('a StreetEasy miss changes nothing but the check time; only StreetEasy\'s own status delists', () => {
  const now = new Date('2026-10-06T12:00:00Z')
  assert.deepEqual(statusUpdateFor(null, now), { streetEasyCheckedAt: now })
  assert.deepEqual(statusUpdateFor({ id: '123', status: 'closed' }, now), { streetEasyId: '123', streetEasyStatus: 'delisted', processingStatus: 'stale', streetEasyCheckedAt: now })
  assert.deepEqual(statusUpdateFor({ id: '9', status: 'sold', url: 'https://streeteasy.com/building/newswalk/204?x=1' }, now), { streetEasyId: 'building/newswalk/204', streetEasyStatus: 'sold', processingStatus: 'stale', streetEasyCheckedAt: now })
  assert.deepEqual(statusUpdateFor({ id: '5', status: 'open' }, now), { streetEasyId: '5', streetEasyStatus: 'active', streetEasyCheckedAt: now })
  assert.deepEqual(mapStatus('in contract'), { streetEasyStatus: 'in_contract' })
  // syncOpportunityStatus writes only statusUpdateFor's fields and has no other delisting path.
  const sync = src('lib/streetEasySync.ts')
  const body = sync.slice(sync.indexOf('export async function syncOpportunityStatus('), sync.indexOf('// ── Shared: cross-reference'))
  assert.match(body, /const data = statusUpdateFor\(listing, new Date\(\)\)/)
  assert.doesNotMatch(body, /'delisted'|'stale'/)
  assert.match(body, /if \(!RAPIDAPI_KEY\) return \{ updated: false/)
  assert.match(sync, /const CHECKABLE_CATEGORIES = SE_CHECKABLE_CATEGORIES/)
  assert.equal(SE_CHECKABLE_CATEGORIES.size, 11)
})

test('listings StreetEasy never found are re-checked every 30 days, not 7 (quota)', () => {
  const sync = src('lib/streetEasySync.ts')
  const sweep = sync.slice(sync.indexOf('export async function runDailyStatusSweep('))
  assert.match(sweep, /\{ streetEasyCheckedAt: null \}/)
  assert.match(sweep, /\{ streetEasyId: \{ not: null \}, streetEasyCheckedAt: \{ lt: sevenDaysAgo \} \}/)
  assert.match(sweep, /\{ streetEasyId: null, streetEasyCheckedAt: \{ lt: thirtyDaysAgo \} \}/)
  assert.match(sweep, /const thirtyDaysAgo = new Date\(Date\.now\(\) - 30 \* 86_400_000\)/)
})

// Brief 48 (4.5) [planner]: Check In (POST /api/sync/run) no longer runs the old
// matcher, lib/matchmaking.ts. That matcher wrote a homeowner's full name and
// street address into Match.reason, and the CRM's morning copy can show a match's
// reason as its "Why" line; homeowner details stay out of buyer-facing text
// [Ryan, 2026-10-19]. The behaviour test runs the real route under tsx on an
// in-memory stand-in for Prisma holding one buyer request created 5 minutes ago
// and one homeowner in its neighborhood: the setup in which the old matcher
// wrote a Match row naming the homeowner. Outlook paused, network refused, no
// database. Every name, address and row is invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// Production's posture for Check In: ingestion allowed (INGESTION_TEST_MODE_ONLY
// is false there), Outlook paused (GRAPH_ENABLED unset), real rows allowed
// (TEST_MODE_ONLY unset: the old matcher looked up homeowners only then).
for (const name of ['INGESTION_TEST_MODE_ONLY', 'GRAPH_ENABLED', 'TEST_MODE_ONLY', 'MATCHING_TEST_MODE_ONLY', 'INGEST_V2', 'RAPIDAPI_KEY', 'DATABASE_URL']) {
  delete process.env[name]
}

type Row = Record<string, unknown>
const BUYER: Row = {
  id: 'iso-fresh', organizationId: 'org-test', category: 'BUYER_ISO', isDuplicate: false, isTestData: false, provenance: null,
  extractedTitle: 'Buyer wants a 2-family in Crown Heights', neighborhood: 'Crown Heights', borough: 'Brooklyn',
  propertyType: 'multi_family', price: null, minPrice: 1_200_000, maxPrice: 1_600_000, beds: null, minBeds: 3, maxBeds: 5,
  streetEasyId: null, streetEasyCheckedAt: null,
  createdAt: new Date(Date.now() - 5 * 60_000), // inside the old matcher's 30-minute window
}
const HOMEOWNER: Row = {
  id: 'contact-1', organizationId: 'org-test', fullName: 'Pat Example', address: '88 Example Ave',
  neighborhood: 'Crown Heights', city: 'Brooklyn',
}
const TABLES: Record<string, Row[]> = {
  organization: [{ id: 'org-test', slug: 'dealflow-ryan' }],
  extractedOpportunity: [BUYER],
  mojoContact: [HOMEOWNER],
}

// Enough of Prisma's `where` for the queries on this path. An unknown filter
// throws, so a query the stand-in can't answer fails the test instead of
// quietly matching nothing.
function fits(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, want]) => {
    if (key === 'OR') return (want as Row[]).some(w => fits(row, w))
    if (key === 'AND') return (want as Row[]).every(w => fits(row, w))
    const got = row[key]
    if (want === null || typeof want !== 'object') return got === want
    if (want instanceof Date) return got instanceof Date && got.getTime() === want.getTime()
    return Object.entries(want as Row).every(([op, x]) => {
      switch (op) {
        case 'not': return x === null ? got != null : got !== x
        case 'in': return (x as unknown[]).includes(got)
        case 'gte': return got instanceof Date && got.getTime() >= (x as Date).getTime()
        case 'contains': return typeof got === 'string' && got.toLowerCase().includes(String(x).toLowerCase())
        case 'mode': return true // 'insensitive': contains above ignores case already
        default: throw new Error(`stand-in: no "${op}" filter`)
      }
    })
  })
}

// lib/prisma uses globalThis.prisma when it is set, so no database client is
// created. Every call is recorded; the route is imported inside the tests, after this.
const READS = new Set(['findMany', 'findFirst', 'findUnique', 'count'])
const calls: Array<{ model: string; op: string; args: Row }> = []
;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy({}, {
  get: (_t, model) => typeof model !== 'string' || model === 'then' ? undefined : new Proxy({}, {
    get: (_u, op) => typeof op !== 'string' || op === 'then' ? undefined : async (args: Row = {}) => {
      calls.push({ model, op, args })
      const found = (TABLES[model] ?? []).filter(r => fits(r, args.where as Row | undefined))
      if (op === 'findMany') return found.slice(0, (args.take as number | undefined) ?? found.length).map(r => ({ ...r }))
      if (op === 'findFirst' || op === 'findUnique') return found[0] ? { ...found[0] } : null
      if (op === 'count') return found.length
      return { id: `${model}-written` } // a write (create, upsert, update, ...): recorded above
    },
  }),
})

const network: string[] = []
globalThis.fetch = (async (input: unknown) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url: string }).url
  network.push(url.split(/[?#]/)[0])
  throw new Error('test: network refused')
}) as typeof fetch

// The old matcher ran after the response was sent, without being awaited. Let
// every pending step finish (the call count stops changing) before looking.
async function settle() {
  let seen = -1
  for (let still = 0, turns = 0; still < 5 && turns < 500; turns++) {
    await new Promise(resolve => setImmediate(resolve))
    if (calls.length === seen) still++
    else { seen = calls.length; still = 0 }
  }
}

test('Check In runs no old matcher: no Match row, and no homeowner name or address in any write', async () => {
  const { POST } = await import('../route')
  const res = await POST()
  await settle()

  assert.equal(res.status, 200)
  const body = await res.json() as Row
  assert.equal(body.skipped, true, 'Outlook is paused: nothing fetched')
  assert.equal(body.readOnly, true)

  const writes = calls.filter(c => !READS.has(c.op))
  const matchWrites = writes.filter(c => c.model === 'match')
  const reasons = matchWrites.map(c => (c.args.data as Row | undefined)?.reason)
  assert.deepEqual(matchWrites.map(c => c.op), [], `no Match row is written; got reasons ${JSON.stringify(reasons)}`)
  const written = JSON.stringify(writes.map(c => c.args))
  for (const detail of [HOMEOWNER.fullName, HOMEOWNER.address]) {
    assert.ok(!written.includes(String(detail)), `no write carries the homeowner's "${detail}"`)
  }
  assert.deepEqual(calls.filter(c => c.model === 'mojoContact').map(c => c.op), [], 'Check In looks up no homeowner while Outlook is paused')
  assert.deepEqual(network, [], 'no network call')
})

// Source check: the route neither imports nor calls the old matcher, and no other
// page or route under app/ imports it (lib/matchmaking.ts itself goes in PR 18).
const ROOT = join(__dirname, '..', '..', '..', '..', '..')
const OLD_MATCHER_IMPORT = /['"][^'"\n]*\blib\/matchmaking(\.ts)?['"]/

function appFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(relative(ROOT, full))
    }
  }
  walk(join(ROOT, 'app'))
  return out
}

test('the Check In route neither imports nor calls the old matcher, and no app route imports it', () => {
  // Code lines only: a comment may still name the old matcher.
  const route = readFileSync(join(ROOT, 'app/api/sync/run/route.ts'), 'utf8')
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
  assert.doesNotMatch(route, /runMatchmaking/, 'the Check In route calls the old matcher')
  assert.doesNotMatch(route, OLD_MATCHER_IMPORT, 'the Check In route imports the old matcher')
  const files = appFiles()
  assert.ok(files.includes(join('app', 'api', 'sync', 'run', 'route.ts')), 'the walk reaches the Check In route')
  assert.deepEqual(files.filter(f => OLD_MATCHER_IMPORT.test(readFileSync(join(ROOT, f), 'utf8'))), [], 'app files that import the old matcher')
})

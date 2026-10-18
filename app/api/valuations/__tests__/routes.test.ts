import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { NextRequest } from 'next/server'
import { makeFakeDb, seedSellers, runInput, valuedRow } from '../../../../lib/valuations/__tests__/fakeDb'

// Brief 44: the three /api/valuations addresses, run under tsx against an in-memory
// stand-in for Prisma (swapped in before the routes load). No database. The key is
// an invented test value; no environment variable is involved.

const db = makeFakeDb()
seedSellers(db, 3)
;(globalThis as unknown as { prisma: unknown }).prisma = db

const KEY = 'test-key-0123456789abcdef0123456789abcdef'
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const url = (p: string) => `http://localhost/api/valuations/${p}`

function storeFingerprint(fingerprint: string | null) {
  db.serviceKey.rows.length = 0
  if (fingerprint !== null) db.serviceKey.rows.push({ id: 'valuation-import', sha256: fingerprint, createdAt: new Date(), rotatedAt: null })
}

async function post(body: unknown, authorization?: string) {
  const { POST } = await import('../import/route')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authorization !== undefined) headers.authorization = authorization
  const req = new NextRequest(url('import'), { method: 'POST', headers, body: JSON.stringify(body) })
  const res = await POST(req)
  return Object.assign(res, { bodyRead: req.bodyUsed })
}
async function targets(authorization?: string) {
  const { GET } = await import('../targets/route')
  return GET(new NextRequest(url('targets'), { headers: authorization !== undefined ? { authorization } : {} }))
}
async function status() {
  const { GET } = await import('../status/route')
  return GET()
}

// The server checks run times against its own clock.
const day = (d: Date) => d.toISOString().slice(0, 10)
const liveRun = (over: Record<string, unknown> = {}) =>
  runInput({ runAt: new Date(Date.now() - 60_000).toISOString(), asOf: day(new Date()), dataThrough: day(new Date(Date.now() - 86_400_000)), ...over })

test('both protected addresses fail closed (503) with no ServiceKey row, a malformed fingerprint or a database error', async () => {
  for (const stored of [null, sha256(KEY).toUpperCase(), sha256(KEY).slice(1), 'z'.repeat(64), '']) {
    storeFingerprint(stored)
    const p = await post({ action: 'start', run: liveRun() }, `Bearer ${KEY}`)
    assert.equal(p.status, 503, `import with stored ${JSON.stringify(stored)}`)
    assert.deepEqual(await p.json(), { ok: false, error: 'not_configured' })
    assert.equal(p.bodyRead, false, 'refused before the body is read')
    const t = await targets(`Bearer ${KEY}`)
    assert.equal(t.status, 503, `targets with stored ${JSON.stringify(stored)}`)
    assert.deepEqual(await t.json(), { ok: false, error: 'not_configured' })
  }
  storeFingerprint(sha256(KEY))
  const real = db.serviceKey.findUnique
  db.serviceKey.findUnique = async () => {
    throw new Error('connection refused')
  }
  try {
    assert.equal((await post({ action: 'start', run: liveRun() }, `Bearer ${KEY}`)).status, 503, 'database error')
    assert.equal((await targets(`Bearer ${KEY}`)).status, 503, 'database error')
  } finally {
    db.serviceKey.findUnique = real
  }
  assert.equal(db.valuationRun.rows.length, 0)
})

test('a missing, wrong, lowercase, raw or short token is refused (401) before the body is read', async () => {
  storeFingerprint(sha256(KEY))
  // (HTTP drops spaces at either end of a header value, so those cases are in auth.test.ts.)
  for (const auth of [undefined, '', `Bearer ${KEY}x`, `Bearer ${KEY.slice(0, -1)}`, KEY, `bearer ${KEY}`, 'Bearer undefined', `Bearer  ${KEY}`, `Bearer\t${KEY}`]) {
    const p = await post({ action: 'start', run: liveRun() }, auth)
    assert.equal(p.status, 401, `import with ${JSON.stringify(auth)}`)
    assert.deepEqual(await p.json(), { ok: false, error: 'unauthorized' })
    assert.equal(p.bodyRead, false)
    const t = await targets(auth)
    assert.equal(t.status, 401, `targets with ${JSON.stringify(auth)}`)
    assert.equal((await t.json()).sellers, undefined)
  }
  const SHORT = 'k'.repeat(31)
  storeFingerprint(sha256(SHORT))
  assert.equal((await post({ action: 'start', run: liveRun() }, `Bearer ${SHORT}`)).status, 401, 'too short to be a key, even if its fingerprint is stored')
  assert.equal((await targets(`Bearer ${SHORT}`)).status, 401)
  assert.equal(db.valuationRun.rows.length, 0)
})

test('the fingerprint is read on every request: a rotated key works at once and the old one stops', async () => {
  const NEXT = 'next-key-fedcba9876543210fedcba9876543210'
  storeFingerprint(sha256(KEY))
  assert.equal((await targets(`Bearer ${KEY}`)).status, 200)
  storeFingerprint(sha256(NEXT))
  assert.equal((await targets(`Bearer ${KEY}`)).status, 401)
  assert.equal((await targets(`Bearer ${NEXT}`)).status, 200)
})

test('public status says "no runs yet" before any run, with or without a key', async () => {
  storeFingerprint(null)
  const res = await status()
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.message, 'no runs yet')
  assert.equal(body.latestRun, null)
  assert.equal(body.latestPublished, null)
})

test('targets list CRM sellers with property fields only', async () => {
  storeFingerprint(sha256(KEY))
  const res = await targets(`Bearer ${KEY}`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.sellers.length, 3, 'test and non-CRM contacts are left out')
  for (const s of body.sellers) {
    assert.deepEqual(Object.keys(s).sort(), ['address', 'buildingSqft', 'cachedBbl', 'city', 'contactId', 'state', 'unitCount', 'zip'])
  }
  const text = JSON.stringify(body)
  for (const leak of ['Homeowner', '2125550100', 'example.com', 'Mailing', 'Elsewhere', KEY]) assert.ok(!text.includes(leak), leak)
  assert.equal(body.previousPublished, null)
})

test('with the right key a run goes in; status then shows times, yes/no, counts and gates only', async () => {
  storeFingerprint(sha256(KEY))
  const runId = 'vr_20261020T100000Z_route1'
  const start = await post({ action: 'start', run: liveRun({ runId, expectedRows: 3 }) }, `Bearer ${KEY}`)
  assert.equal(start.status, 200, JSON.stringify(await start.clone().json()))
  const rows = await post({ action: 'rows', runId, rows: ['c0000', 'c0001', 'c0002'].map(valuedRow) }, `Bearer ${KEY}`)
  assert.equal(rows.status, 200, JSON.stringify(await rows.clone().json()))
  // Too few valued sellers for the 1,300 gate, so it stays unpublished.
  const pub = await post({ action: 'publish', runId }, `Bearer ${KEY}`)
  assert.equal(pub.status, 409)

  const body = await (await status()).json()
  assert.equal(body.message, null)
  const run = body.latestRun
  assert.deepEqual(Object.keys(run).sort(), ['asOf', 'counts', 'dataThrough', 'gates', 'gatesPassed', 'modelVersion', 'published', 'publishedAt', 'runAt'])
  assert.equal(run.published, false)
  assert.equal(run.modelVersion, 'dealflow-gbm90-v1')
  assert.deepEqual(run.gates.map((g: { key: string }) => g.key), ['typical_miss_all', 'typical_miss_top8_2to4', 'range_coverage', 'sellers_valued'])
  for (const g of run.gates) assert.deepEqual(Object.keys(g).sort(), ['key', 'max', 'min', 'pass', 'value'])
  const text = JSON.stringify(body)
  for (const leak of ['1830000', '1537200', '3018230045', 'SAMPLE AVENUE', 'Example Street', 'c0000', 'R6B', 'metrics', 'scoreboard', 'sources', 'gate_months', 'usep-8jbt', KEY]) {
    assert.ok(!text.includes(leak), `status leaked ${leak}`)
  }
})

test('the import refuses an oversized or non-JSON body', async () => {
  storeFingerprint(sha256(KEY))
  const { POST } = await import('../import/route')
  const big = await POST(new NextRequest(url('import'), {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-length': '5000000' }, body: '{}',
  }))
  assert.equal(big.status, 413)
  const multiByte = await POST(new NextRequest(url('import'), {
    method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: `"${'é'.repeat(2_000_001)}"`,
  }))
  assert.equal(multiByte.status, 413, 'the limit counts bytes, not characters')
  const junk = await POST(new NextRequest(url('import'), { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: 'not json' }))
  assert.equal(junk.status, 400)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { makeFakeDb, seedSellers, runInput, valuedRow } from '../../../../lib/valuations/__tests__/fakeDb'

// Brief 44: the three /api/valuations addresses, run under tsx against an in-memory
// stand-in for Prisma (swapped in before the routes load). No database.

const db = makeFakeDb()
seedSellers(db, 3)
;(globalThis as unknown as { prisma: unknown }).prisma = db

const SECRET = 'test-secret-0123456789abcdef'
const url = (p: string) => `http://localhost/api/valuations/${p}`

async function post(body: unknown, authorization?: string) {
  const { POST } = await import('../import/route')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authorization !== undefined) headers.authorization = authorization
  return POST(new NextRequest(url('import'), { method: 'POST', headers, body: JSON.stringify(body) }))
}
async function targets(authorization?: string) {
  const { GET } = await import('../targets/route')
  return GET(new NextRequest(url('targets'), { headers: authorization !== undefined ? { authorization } : {} }))
}
async function status() {
  const { GET } = await import('../status/route')
  return GET()
}

test('both protected addresses fail closed when the secret is unset or too short', async () => {
  for (const value of [undefined, '', 'short']) {
    if (value === undefined) delete process.env.VALUATION_IMPORT_SECRET
    else process.env.VALUATION_IMPORT_SECRET = value
    const p = await post({ action: 'publish', runId: 'vr_20261020T100000Z_aaaaaa' }, `Bearer ${value ?? 'undefined'}`)
    assert.equal(p.status, 500, `import with secret ${JSON.stringify(value)}`)
    assert.equal((await p.json()).error, 'not_configured')
    const t = await targets(`Bearer ${value ?? 'undefined'}`)
    assert.equal(t.status, 500, `targets with secret ${JSON.stringify(value)}`)
  }
  assert.equal(db.valuationRun.rows.length, 0)
})

test('a missing or wrong token is refused before anything is read or written', async () => {
  process.env.VALUATION_IMPORT_SECRET = SECRET
  for (const auth of [undefined, '', `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, SECRET, `bearer ${SECRET}`, 'Bearer undefined']) {
    const p = await post({ action: 'start', run: runInput() }, auth)
    assert.equal(p.status, 401, `import with ${JSON.stringify(auth)}`)
    const t = await targets(auth)
    assert.equal(t.status, 401, `targets with ${JSON.stringify(auth)}`)
    const body = await t.json()
    assert.equal(body.sellers, undefined)
  }
  assert.equal(db.valuationRun.rows.length, 0)
})

test('public status says "no runs yet" before any run', async () => {
  const res = await status()
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.message, 'no runs yet')
  assert.equal(body.latestRun, null)
  assert.equal(body.latestPublished, null)
})

test('targets list CRM sellers with property fields only', async () => {
  process.env.VALUATION_IMPORT_SECRET = SECRET
  const res = await targets(`Bearer ${SECRET}`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.sellers.length, 3, 'test and non-CRM contacts are left out')
  for (const s of body.sellers) {
    assert.deepEqual(Object.keys(s).sort(), ['address', 'buildingSqft', 'cachedBbl', 'city', 'contactId', 'state', 'unitCount', 'zip'])
  }
  const text = JSON.stringify(body)
  for (const leak of ['Homeowner', '2125550100', 'example.com', 'Mailing', 'Elsewhere']) assert.ok(!text.includes(leak), leak)
  assert.equal(body.previousPublished, null)
})

test('with the right token a run goes in; status then shows times, yes/no, counts and gates only', async () => {
  process.env.VALUATION_IMPORT_SECRET = SECRET
  const runId = 'vr_20261020T100000Z_route1'
  const start = await post({ action: 'start', run: runInput({ runId, expectedRows: 3 }) }, `Bearer ${SECRET}`)
  assert.equal(start.status, 200)
  const rows = await post({ action: 'rows', runId, rows: ['c0000', 'c0001', 'c0002'].map(valuedRow) }, `Bearer ${SECRET}`)
  assert.equal(rows.status, 200)
  // Too few valued sellers for the 1,300 gate, so it stays unpublished.
  const pub = await post({ action: 'publish', runId }, `Bearer ${SECRET}`)
  assert.equal(pub.status, 409)

  const body = await (await status()).json()
  assert.equal(body.message, null)
  const run = body.latestRun
  assert.deepEqual(Object.keys(run).sort(), ['asOf', 'counts', 'dataThrough', 'gates', 'gatesPassed', 'modelVersion', 'published', 'publishedAt', 'runAt'])
  assert.equal(run.published, false)
  assert.deepEqual(run.gates.map((g: { key: string }) => g.key), ['typical_miss_all', 'typical_miss_top8_2to4', 'range_coverage', 'sellers_valued'])
  for (const g of run.gates) assert.deepEqual(Object.keys(g).sort(), ['key', 'max', 'min', 'pass', 'value'])
  const text = JSON.stringify(body)
  for (const leak of ['1830000', '1537200', '3018230045', 'SAMPLE AVENUE', 'Example Street', 'c0000', 'R6B', 'metrics', 'scoreboard', 'sources']) {
    assert.ok(!text.includes(leak), `status leaked ${leak}`)
  }
})

test('the import refuses an oversized or non-JSON body', async () => {
  process.env.VALUATION_IMPORT_SECRET = SECRET
  const { POST } = await import('../import/route')
  const big = await POST(new NextRequest(url('import'), {
    method: 'POST', headers: { authorization: `Bearer ${SECRET}`, 'content-length': '5000000' }, body: '{}',
  }))
  assert.equal(big.status, 413)
  const junk = await POST(new NextRequest(url('import'), { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: 'not json' }))
  assert.equal(junk.status, 400)
})

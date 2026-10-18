// Must be the first import: it points lib/prisma at the in-memory stand-in.
import { current } from '../../../../../lib/__tests__/globalMemoryDb'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

// Brief 45 (PR E): the route itself. A body that can't be read as the
// contract's JSON is refused with 400 before anything is read: the CRM link
// is never opened, and DealFlow's database is never touched. No database.

const URL = 'https://dealflow.example/api/crm/score-import'
const post = (body: string) => new NextRequest(URL, { method: 'POST', body, headers: { 'content-type': 'application/json' } })

test('POST only, up to 300 seconds, never cached', async () => {
  const route = await import('../route')
  assert.equal(route.maxDuration, 300)
  assert.equal(route.dynamic, 'force-dynamic')
  assert.equal(typeof route.POST, 'function')
  for (const m of ['GET', 'PUT', 'PATCH', 'DELETE']) assert.equal((route as Record<string, unknown>)[m], undefined, m)
})

test('unreadable, oversized or wrongly shaped bodies get 400 invalid_request and touch nothing', async () => {
  const { POST } = await import('../route')
  const token = 'A'.repeat(43)
  for (const body of [
    'not json', '', '[1,2]', JSON.stringify({ importId: 'imp_1', token, leadIds: [] }),
    JSON.stringify({ importId: 'imp_1', token, leadIds: ['a'], pad: 'x'.repeat(70_000) }), // over the 64 KB cap
  ]) {
    const res = await POST(post(body))
    assert.equal(res.status, 400, body.slice(0, 40))
    assert.deepEqual(await res.json(), { error: 'invalid_request' })
  }
  assert.equal(current.mem.calls.length, 0)
  assert.equal(current.mem.touched.size, 0)
})

// Brief 48 (PR 3, item 4.7): lib/review/send.ts, what the Review Queue page does
// with the server's reply. A save that was refused or failed comes back as a
// message to show (so the page keeps the item and the open form); a save that
// worked comes back as null. Pure: a stand-in fetch, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SAVE_FAILED, UNREACHABLE, sendReviewAction } from '../send'

type Call = { url: string; init: RequestInit }

function fakeFetch(reply: () => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return reply()
  }) as unknown as typeof fetch
  return { fn, calls }
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('a save that worked comes back as null, and the request carries what was typed', async () => {
  const { fn, calls } = fakeFetch(() => json(200, { ok: true, newStatus: 'corrected' }))
  const problem = await sendReviewAction({ id: 'rqi_1', action: 'correct', corrections: { price: '1.25M', beds: '3' } }, fn)
  assert.equal(problem, null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/review')
  assert.equal(calls[0].init.method, 'PATCH')
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { id: 'rqi_1', action: 'correct', corrections: { price: '1.25M', beds: '3' } })
})

test('a refused save comes back as the server\'s message', async () => {
  const message = 'Price must be a number, like 1250000, $1,250,000, 1.25M or 950k.'
  const { fn } = fakeFetch(() => json(400, { ok: false, error: message }))
  assert.equal(await sendReviewAction({ id: 'rqi_1', action: 'correct', corrections: { price: 'lots' } }, fn), message)
})

test('a failed save with no message of its own gets a calm one', async () => {
  for (const reply of [
    () => new Response('<html>Internal Server Error</html>', { status: 500 }),
    () => json(502, { nothing: 'here' }),
    () => json(500, { error: '   ' }),
    () => new Response(null, { status: 504 }),
  ]) {
    const { fn } = fakeFetch(reply)
    assert.equal(await sendReviewAction({ id: 'rqi_1', action: 'approve' }, fn), SAVE_FAILED)
  }
})

test('when DealFlow can\'t be reached, the page says the item is still in the queue', async () => {
  const fn = (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch
  assert.equal(await sendReviewAction({ id: 'rqi_1', action: 'reject' }, fn), UNREACHABLE)
})

test('the page\'s own messages are calm', () => {
  for (const m of [SAVE_FAILED, UNREACHABLE]) {
    assert.ok(!m.includes('!') && !m.includes('—'), m)
    assert.match(m, /still in the queue/)
  }
})

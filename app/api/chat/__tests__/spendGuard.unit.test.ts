import { current, fakePrisma, ORG, countFetches } from '../../../../lib/__tests__/pr17FakePrisma' // first: no database client
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { installFakeAiFetch } from '../../../../lib/__tests__/fakeAiFetch'
import { hashAddress, startOfNewYorkDay, SPEND_GUARD_REQUEST, SPEND_GUARD_REFUSED } from '../../../../lib/spendGuard'

// Brief 43 PR 17 [engineering precaution] (DealFlow has no login [Ryan,
// 2026-09-24]): POST /api/chat refuses at the very top, before the
// message parser (a paid gpt-4o-mini call), before Claude, and before any chat
// session is created or written. Fake Prisma, fake AI, network refused.

const ai = installFakeAiFetch()
const outside = countFetches()
const IP = '203.0.113.7'

beforeEach(() => {
  current.fake = fakePrisma()
  ai.requests.length = 0
  outside.length = 0
})

async function post(body: unknown, ip: string | null = IP) {
  const { POST } = await import('../route')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (ip) headers['x-forwarded-for'] = ip
  return POST(new NextRequest('http://localhost/api/chat', { method: 'POST', headers, body: JSON.stringify(body) }))
}

const ago = (ms: number) => new Date(Date.now() - ms)
const counter = (ipHash: string, ageMs: number) =>
  ({ id: `c_${Math.random()}`, organizationId: ORG, action: SPEND_GUARD_REQUEST, createdAt: ago(ageMs), detailsJson: { route: 'chat', ipHash } })

function assertRefusedCleanly(reason: string) {
  const { data, calls } = current.fake
  assert.equal(ai.requests.length + outside.length, 0, 'no Anthropic or OpenAI call, no outside call at all')
  assert.ok(!calls.some(c => c.startsWith('chatSession.') || c.startsWith('chatMessage.')), `no chat session work: ${calls.join(', ')}`)
  const refusals = data.auditLog.filter(r => r.action === SPEND_GUARD_REFUSED)
  assert.equal(refusals.length, 1)
  assert.deepEqual(refusals[0].detailsJson, { route: 'chat', reason }, 'counts only: the route and the reason')
  assert.ok(!JSON.stringify(data.auditLog).includes(IP), 'the address is never stored')
}

test('daily dollar cap reached → plain 429 with the stock text, before any paid call or session', async () => {
  // Earlier today, whatever the time (a minute ago is yesterday just after midnight).
  const today = Math.min(60_000, (Date.now() - startOfNewYorkDay().getTime()) / 2)
  current.fake.data.driftInteraction.push({ id: 'd1', createdAt: ago(today), costUsd: 3.1 }, { id: 'd2', createdAt: ago(today / 2), costUsd: 2.0 })
  const res = await post({ message: 'any coming soon in bedstuy?' })
  assert.equal(res.status, 429)
  const body = await res.json()
  assert.equal(body.error, 'spend_limit')
  assert.equal(body.message, "Drift's daily spending limit is reached. It resets at midnight.")
  assert.equal(body.response, body.message, 'the chat page shows `response` as Drift’s bubble')
  assert.equal(body.sessionId, undefined, 'no session')
  assertRefusedCleanly('daily_usd')
})

test('yesterday’s spend doesn’t count', async () => {
  current.fake.data.driftInteraction.push({ id: 'd1', createdAt: ago(30 * 3_600_000), costUsd: 50 })
  const res = await post({ message: '' })
  assert.equal(res.status, 400, 'reached the route’s own checks')
})

test('the 11th message in a minute from one address → 429, before any paid call or session', async () => {
  const me = hashAddress(IP)
  for (let i = 0; i < 10; i++) current.fake.data.auditLog.push(counter(me, 20_000))
  const res = await post({ message: 'any coming soon in bedstuy?' })
  assert.equal(res.status, 429)
  assertRefusedCleanly('ip_per_minute')
})

test('the daily message backstop (all addresses) → 429 with the stock text', async () => {
  // Earlier today (an hour ago is yesterday between midnight and 1 am New York time).
  const today = Math.min(3_600_000, (Date.now() - startOfNewYorkDay().getTime()) / 2)
  for (let i = 0; i < 200; i++) current.fake.data.auditLog.push(counter(`someone_${i}`, today))
  const res = await post({ message: 'any coming soon in bedstuy?' })
  assert.equal(res.status, 429)
  assert.equal((await res.json()).message, "Drift's daily spending limit is reached. It resets at midnight.")
  assertRefusedCleanly('daily_messages')
})

test('no address header shares one bucket (not a way around the limit)', async () => {
  const anon = hashAddress('unknown')
  for (let i = 0; i < 10; i++) current.fake.data.auditLog.push(counter(anon, 20_000))
  const res = await post({ message: 'hello' }, null)
  assert.equal(res.status, 429)
})

test('under every limit the message goes on, counted once under the hashed address', async () => {
  const res = await post({ message: '' }) // the route's own 400, so no AI reply is needed
  assert.equal(res.status, 400)
  const counted = current.fake.data.auditLog.filter(r => r.action === SPEND_GUARD_REQUEST)
  assert.equal(counted.length, 1)
  assert.deepEqual(counted[0].detailsJson, { route: 'chat', ipHash: hashAddress(IP) })
  assert.equal(counted[0].organizationId, ORG)
  assert.ok(!JSON.stringify(current.fake.data.auditLog).includes(IP))
})

test('a DB hiccup inside the guard lets Ryan’s message through (proceed and log)', async () => {
  current.fake.failing.add('auditLog.findMany')
  const orig = console.error
  console.error = () => {}
  try {
    const res = await post({ message: '' })
    assert.equal(res.status, 400, 'not refused, not a 500: the route carried on')
  } finally { console.error = orig }
})

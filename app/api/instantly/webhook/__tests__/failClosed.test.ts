import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

// Brief 41.2 (PR C): POST /api/instantly/webhook fails closed. It is refused
// unless INSTANTLY_ENROLL_ENABLED is exactly 'true' AND INSTANTLY_WEBHOOK_SECRET
// is set AND the request carries `Authorization: Bearer <that secret>`. Until
// all three hold it reads no body and touches no database. Engineering
// precaution from the Oct 16, 2026 system-map review; Instantly itself stays off
// (Ryan's instruction, Sep 24, 2026: nothing may call, text or email CRM leads
// while testing). Runs under tsx against an in-memory stand-in for Prisma; no
// database.

const SECRET = 'test-only-webhook-secret-6f1c'
const keys = ['INSTANTLY_ENROLL_ENABLED', 'INSTANTLY_WEBHOOK_SECRET', 'TEST_MODE_ONLY'] as const
const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]))
after(() => {
  for (const k of keys) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})
function setEnv(k: (typeof keys)[number], v: string | undefined) {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

const calls: string[] = []
const created: Array<{ data: Record<string, unknown> }> = []
const fakePrisma = {
  organization: { findUnique: async () => { calls.push('organization.findUnique'); return { id: 'org_b412' } } },
  mojoContact: {
    findFirst: async () => { calls.push('mojoContact.findFirst'); return null },
    update: async () => { calls.push('mojoContact.update'); return {} },
  },
  instantlyEvent: {
    create: async (args: { data: Record<string, unknown> }) => { calls.push('instantlyEvent.create'); created.push(args); return {} },
  },
}
;(globalThis as unknown as { prisma: unknown }).prisma = fakePrisma

function hook(headers: Record<string, string> = {}, query = '') {
  return new NextRequest(`http://localhost/api/instantly/webhook${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ event_type: 'email_opened', lead_email: 'lead@example.com', campaign_id: 'campaign_1' }),
  })
}
const RIGHT = { authorization: `Bearer ${SECRET}` }

// A refusal: the given status, ok:false, the body never read, no database call.
async function refused(req: NextRequest, status: number, label: string) {
  const { POST } = await import('../route')
  calls.length = 0
  const res = await POST(req)
  assert.equal(res.status, status, label)
  assert.equal((await res.json()).ok, false, label)
  assert.equal(req.bodyUsed, false, `${label}: body read`)
  assert.deepEqual(calls, [], `${label}: database touched`)
}

test('503 while the switch is off, even with the right token', async () => {
  setEnv('TEST_MODE_ONLY', 'false')
  setEnv('INSTANTLY_WEBHOOK_SECRET', SECRET)
  for (const v of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true ']) {
    setEnv('INSTANTLY_ENROLL_ENABLED', v)
    await refused(hook(RIGHT), 503, `INSTANTLY_ENROLL_ENABLED=${JSON.stringify(v)}`)
  }
})

test('503 when the switch is on but no secret is set', async () => {
  setEnv('TEST_MODE_ONLY', 'false')
  setEnv('INSTANTLY_ENROLL_ENABLED', 'true')
  for (const v of [undefined, '', '   ']) {
    setEnv('INSTANTLY_WEBHOOK_SECRET', v)
    const headers: Array<Record<string, string>> = [{}, { authorization: 'Bearer ' }, { authorization: 'Bearer undefined' }, { authorization: `Bearer ${v ?? ''}` }]
    for (const h of headers) {
      await refused(hook(h), 503, `secret=${JSON.stringify(v)} header=${JSON.stringify(h)}`)
    }
  }
})

test('401 on a missing or wrong token', async () => {
  setEnv('TEST_MODE_ONLY', 'false')
  setEnv('INSTANTLY_ENROLL_ENABLED', 'true')
  setEnv('INSTANTLY_WEBHOOK_SECRET', SECRET)
  const wrong: Array<Record<string, string>> = [
    {},
    { authorization: 'Bearer wrong' },
    { authorization: `Bearer ${SECRET}x` },
    { authorization: `Bearer ${SECRET.slice(0, -1)}` },
    { authorization: SECRET },
    { authorization: `bearer ${SECRET}` },
    { authorization: `Bearer  ${SECRET}` },
    { authorization: `Basic ${SECRET}` },
    { authorization: 'Bearer undefined' },
    { 'x-webhook-secret': SECRET },
  ]
  for (const h of wrong) await refused(hook(h), 401, JSON.stringify(h))
  // The token travels in the header only; a URL token is not accepted.
  await refused(hook({}, `?token=${SECRET}`), 401, '?token=')
  await refused(hook({}, `?secret=${SECRET}`), 401, '?secret=')
})

test('the right token reaches the handler', async () => {
  setEnv('TEST_MODE_ONLY', 'false')
  setEnv('INSTANTLY_ENROLL_ENABLED', 'true')
  setEnv('INSTANTLY_WEBHOOK_SECRET', SECRET)
  const { POST } = await import('../route')
  calls.length = 0
  created.length = 0
  const res = await POST(hook(RIGHT))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
  assert.ok(calls.includes('instantlyEvent.create'), JSON.stringify(calls))
  assert.equal(created[0].data.email, 'lead@example.com')
  assert.equal(created[0].data.eventType, 'email_opened')
})

test('TEST_MODE_ONLY still applies after the checks pass', async () => {
  setEnv('TEST_MODE_ONLY', 'true')
  setEnv('INSTANTLY_ENROLL_ENABLED', 'true')
  setEnv('INSTANTLY_WEBHOOK_SECRET', SECRET)
  const { POST } = await import('../route')
  calls.length = 0
  const res = await POST(hook(RIGHT))
  assert.deepEqual(await res.json(), { ok: false, reason: 'TEST_MODE_ONLY is on' })
  assert.deepEqual(calls, [])
})

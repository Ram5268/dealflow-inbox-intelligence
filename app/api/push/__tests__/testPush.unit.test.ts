// Brief 48 (PR 5): Settings' "Send Test Push" sends at most one test a minute
// [planner, Brief 48 §3 PR 5]. A second press within the minute gets 429 and a plain
// message, which the Settings page shows; presses that arrive together still send
// only one. The test's PUSH_SENT row (kind 'test') is the record, so no new table.
// Runs on stand-ins for Prisma and web-push (nothing is sent); every device is invented.
import { ORG, db, installFakeWebPush, resetDb, sent, type Row } from '@/lib/push/__tests__/pushFakes'
import { test } from 'node:test'
import assert from 'node:assert/strict'

installFakeWebPush()

const DEVICES = () => [1, 2].map(n => ({
  id: `dev-${n}`, organizationId: ORG, endpoint: `https://push.example.invalid/device-${n}`,
  p256dh: `fake-p256dh-${n}`, auth: `fake-auth-${n}`, createdAt: new Date(`2026-10-0${n}T12:00:00Z`),
}))
async function press() {
  const { POST } = await import('../test/route')
  const res = await POST()
  return { status: res.status, json: await res.json() as Row }
}
const testRows = () => (db.tables.auditLog ?? []).filter(r => r.action === 'PUSH_SENT' && (r.detailsJson as Row)?.kind === 'test')
const plain = (msg: unknown) => assert.ok(!/endpoint|subscription|VAPID|!|—/i.test(String(msg)), `plain English: ${msg}`)

test('a second test within a minute is refused with a plain message', async () => {
  resetDb({ pushSubscription: DEVICES() })
  const first = await press()
  assert.equal(first.status, 200)
  assert.deepEqual(first.json, { ok: true, delivered: 2 })
  assert.equal(sent.length, 2)

  const second = await press()
  assert.equal(second.status, 429)
  assert.equal(second.json.ok, false)
  assert.match(String(second.json.error), /one test a minute/)
  plain(second.json.error)
  assert.equal(sent.length, 2, 'nothing more is sent')
  assert.equal(testRows().length, 1, 'one PUSH_SENT row for the one test')
  assert.equal((testRows()[0].detailsJson as Row).delivered, 2)
})

test('after a minute, a test goes through again', async () => {
  resetDb({ pushSubscription: DEVICES() })
  await press()
  for (const r of testRows()) r.createdAt = new Date(Date.now() - 61_000)
  const later = await press()
  assert.equal(later.status, 200)
  assert.equal(sent.length, 4)
})

test('presses that arrive together send only one test', async () => {
  resetDb({ pushSubscription: DEVICES() })
  const results = await Promise.all(Array.from({ length: 5 }, () => press()))
  assert.ok(results.filter(r => r.status === 200).length <= 1, results.map(r => r.status).join(','))
  assert.ok(results.every(r => r.status === 200 || r.status === 429))
  assert.ok(sent.length <= 2, `${sent.length} pushes sent`)
  assert.ok(testRows().length <= 1, `${testRows().length} test rows kept`)
})

test('a test that reached no device does not use up the minute', async () => {
  resetDb()
  const none = await press()
  assert.equal(none.status, 200)
  assert.equal(none.json.ok, false)
  assert.match(String(none.json.error), /Check In/)
  plain(none.json.error)
  db.tables.pushSubscription = DEVICES()
  const next = await press()
  assert.equal(next.status, 200)
  assert.deepEqual(next.json, { ok: true, delivered: 2 })
})

test('with push not set up on the server, the message is plain and nothing is logged', async () => {
  resetDb({ pushSubscription: DEVICES() })
  const keep = { pub: process.env.VAPID_PUBLIC_KEY, priv: process.env.VAPID_PRIVATE_KEY }
  delete process.env.VAPID_PRIVATE_KEY
  try {
    const r = await press()
    assert.equal(r.status, 503)
    plain(r.json.error)
  } finally {
    process.env.VAPID_PUBLIC_KEY = keep.pub
    process.env.VAPID_PRIVATE_KEY = keep.priv
  }
  assert.equal(sent.length, 0)
  assert.equal(testRows().length, 0)
})

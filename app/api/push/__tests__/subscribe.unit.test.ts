// Brief 48 (PR 5): at most 5 devices get notifications, and Settings lists them with
// "Remove" [planner, Brief 48 §3 PR 5]. POST /api/push/subscribe refuses a 6th new
// device with a plain message, but a device that's already stored can always sign up
// again. GET lists the devices with a plain label, the date added and a short
// fingerprint, never the push address or keys. DELETE removes one, only within the
// current organization. Runs on a stand-in for Prisma; nothing is sent, and every
// device is invented.
import { ORG, OTHER_ORG, db, resetDb, type Row } from '@/lib/push/__tests__/pushFakes'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { NextRequest } from 'next/server'

const URL_ = 'http://localhost/api/push/subscribe'
const ENDPOINTS = [
  'https://web.push.apple.com/QFake-device-1',
  'https://fcm.googleapis.com/fcm/send/fake-device-2',
  'https://updates.push.services.mozilla.com/wpush/v2/fake-device-3',
  'https://wns2-fake.notify.windows.com/w/?token=fake-device-4',
  'https://push.example.invalid/fake-device-5',
  'https://push.example.invalid/fake-device-6',
  'https://push.example.invalid/fake-device-7',
]
const sub = (n: number, keyTag = 'a') => ({
  endpoint: ENDPOINTS[n - 1], expirationTime: null, keys: { p256dh: `fake-p256dh-${n}-${keyTag}`, auth: `fake-auth-${n}-${keyTag}` },
})
const route = () => import('../subscribe/route')
const req = (method: string, body?: unknown) =>
  new NextRequest(URL_, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })

async function post(body: unknown) {
  const res = await (await route()).POST(req('POST', body))
  return { status: res.status, json: await res.json() as Row }
}
async function list() {
  const res = await (await route()).GET()
  assert.equal(res.status, 200)
  return { text: await res.clone().text(), json: await res.json() as { devices: Array<Row> } }
}
async function remove(body: unknown) {
  const res = await (await route()).DELETE(req('DELETE', body))
  return { status: res.status, json: await res.json() as Row }
}
const stored = () => (db.tables.pushSubscription ?? []).filter(r => r.organizationId === ORG)
const otherOrgDevice = () => ({
  id: 'dev-other', organizationId: OTHER_ORG, endpoint: 'https://push.example.invalid/other-org',
  p256dh: 'fake-p256dh-other', auth: 'fake-auth-other', createdAt: new Date('2026-10-01T00:00:00Z'),
})

test('five devices can sign up; the sixth is refused with a plain message', async () => {
  resetDb()
  for (let n = 1; n <= 5; n++) assert.equal((await post(sub(n))).status, 200, `device ${n}`)
  const sixth = await post(sub(6))
  assert.equal(sixth.status, 409)
  assert.equal(sixth.json.ok, false)
  const msg = String(sixth.json.error)
  assert.match(msg, /5 devices/)
  assert.match(msg, /Remove one in Settings/)
  assert.ok(!/endpoint|subscription|VAPID|organi[sz]ation|!|—/i.test(msg), `plain English: ${msg}`)
  assert.equal(stored().length, 5)
  assert.ok(!stored().some(r => r.endpoint === ENDPOINTS[5]), 'the sixth is not stored')
})

test('a stored device can sign up again at five, and its keys are refreshed', async () => {
  resetDb()
  for (let n = 1; n <= 5; n++) await post(sub(n))
  const again = await post(sub(3, 'renewed'))
  assert.equal(again.status, 200)
  assert.equal(stored().length, 5)
  const row = stored().find(r => r.endpoint === ENDPOINTS[2])!
  assert.equal(row.p256dh, 'fake-p256dh-3-renewed')
  assert.equal(row.auth, 'fake-auth-3-renewed')
})

test('sign-ups that arrive together never leave more than five', async () => {
  resetDb()
  for (let n = 1; n <= 3; n++) await post(sub(n))
  const results = await Promise.all([4, 5, 6, 7].map(n => post(sub(n))))
  for (const r of results) assert.ok(r.status === 200 || r.status === 409, `status ${r.status}`)
  assert.ok(stored().length <= 5, `${stored().length} devices stored`)
  assert.equal(stored().length, 3 + results.filter(r => r.status === 200).length, 'every 200 is a stored device, every 409 is not')
})

test('another organization\'s devices do not count toward the five', async () => {
  resetDb({ pushSubscription: [otherOrgDevice()] })
  for (let n = 1; n <= 5; n++) assert.equal((await post(sub(n))).status, 200, `device ${n}`)
})

test('the list shows a plain label, the date added and a fingerprint, never the address or keys', async () => {
  resetDb({ pushSubscription: [otherOrgDevice()] })
  for (let n = 1; n <= 5; n++) await post(sub(n))
  const { text, json } = await list()
  assert.equal(json.devices.length, 5, 'only this organization\'s devices')
  for (const d of json.devices) assert.deepEqual(Object.keys(d).sort(), ['addedAt', 'fingerprint', 'id', 'label'])
  assert.deepEqual(json.devices.map(d => d.label), ['iPhone, iPad or Mac (Safari)', 'Chrome or Android', 'Firefox', 'Edge', 'Browser'])
  for (const [i, d] of json.devices.entries()) {
    assert.equal(d.fingerprint, createHash('sha256').update(ENDPOINTS[i]).digest('hex').slice(0, 12))
    assert.ok(!Number.isNaN(Date.parse(String(d.addedAt))), 'addedAt is a date')
  }
  for (const n of [1, 2, 3, 4, 5]) {
    const s = sub(n)
    for (const secret of [s.endpoint, s.keys.p256dh, s.keys.auth]) assert.ok(!text.includes(secret), `the list leaks ${secret}`)
  }
  assert.ok(!text.includes('other-org'), 'nothing from another organization')
  assert.ok(!/"(endpoint|p256dh|auth|keys)"/.test(text), 'no address or key fields at all')
})

test('Remove deletes one device, and a freed slot can be used again', async () => {
  resetDb()
  for (let n = 1; n <= 5; n++) await post(sub(n))
  const { json } = await list()
  const target = json.devices[1]
  const res = await remove({ id: target.id })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json, { ok: true, removed: 1 })
  assert.equal(stored().length, 4)
  assert.ok(!(await list()).json.devices.some(d => d.id === target.id), 'gone from the list')
  assert.deepEqual((await remove({ id: target.id })).json, { ok: true, removed: 0 }, 'removing it twice is harmless')
  assert.equal((await post(sub(6))).status, 200, 'the freed slot takes a new device')
})

test('Remove cannot touch another organization\'s device', async () => {
  resetDb({ pushSubscription: [otherOrgDevice()] })
  await post(sub(1))
  const res = await remove({ id: 'dev-other' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json, { ok: true, removed: 0 })
  assert.ok((db.tables.pushSubscription ?? []).some(r => r.id === 'dev-other'), 'still stored')
  assert.equal(stored().length, 1)
})

test('bad requests are refused and change nothing', async () => {
  resetDb()
  for (const body of [{}, { endpoint: ENDPOINTS[0] }, { endpoint: ENDPOINTS[0], keys: { p256dh: 'x' } },
    { endpoint: 'http://push.example.invalid/plain-http', keys: { p256dh: 'x', auth: 'y' } },
    { endpoint: 'not a web address', keys: { p256dh: 'x', auth: 'y' } },
    { endpoint: 42, keys: { p256dh: 'x', auth: 'y' } },
    '{not json']) {
    assert.equal((await post(body)).status, 400, `POST ${JSON.stringify(body)}`)
  }
  for (const body of [{}, { id: 7 }, { id: '' }, '{not json']) {
    const r = await remove(body)
    assert.equal(r.status, 400, `DELETE ${JSON.stringify(body)}`)
    assert.equal(r.json.ok, false)
  }
  assert.equal((db.tables.pushSubscription ?? []).length, 0)
})

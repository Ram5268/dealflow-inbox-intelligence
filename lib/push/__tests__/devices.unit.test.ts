// Brief 48 (PR 5): the device helpers shared by /api/push/subscribe and the Settings
// device list [planner, Brief 48 §3 PR 5]: the plain label from the push service's
// web address, the short fingerprint that marks "This device", what a sign-up must
// look like, and the list's wording. Pure: no database, no network, no browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  MAX_PUSH_DEVICES, DEVICE_LIMIT_MESSAGE, NO_DEVICES_MESSAGE,
  deviceLabel, deviceRows, devicesNote, endpointFingerprint, parseSubscription,
} from '../devices'

test('the limit is 5 devices, and the refusal says so plainly', () => {
  assert.equal(MAX_PUSH_DEVICES, 5)
  assert.match(DEVICE_LIMIT_MESSAGE, /5 devices/)
  assert.ok(!/endpoint|subscription|VAPID|organi[sz]ation|!|—/i.test(DEVICE_LIMIT_MESSAGE), DEVICE_LIMIT_MESSAGE)
})

test('a plain label from the push service, never the web address itself', () => {
  const cases: Array<[string, string]> = [
    ['https://web.push.apple.com/QFake-1', 'iPhone, iPad or Mac (Safari)'],
    ['https://fcm.googleapis.com/fcm/send/fake-2', 'Chrome'],
    ['https://android.googleapis.com/gcm/send/fake-3', 'Chrome'],
    ['https://updates.push.services.mozilla.com/wpush/v2/fake-4', 'Firefox'],
    ['https://wns2-fake.notify.windows.com/w/?token=fake-5', 'Edge'],
    ['https://push.example.invalid/fake-6', 'Browser'],
    // Look-alikes are just "Browser".
    ['https://web.push.apple.com.example.invalid/fake-7', 'Browser'],
    ['https://notapple.com/push.apple.com', 'Browser'],
    ['https://evilgoogleapis.com/fake-8', 'Browser'],
    ['not a web address', 'Browser'],
  ]
  for (const [endpoint, label] of cases) assert.equal(deviceLabel(endpoint), label, endpoint)
})

test('the fingerprint is the first 12 characters of the SHA-256 of the push address', async () => {
  const a = 'https://web.push.apple.com/QFake-1'
  const b = 'https://web.push.apple.com/QFake-2'
  assert.equal(await endpointFingerprint(a), createHash('sha256').update(a).digest('hex').slice(0, 12))
  assert.notEqual(await endpointFingerprint(a), await endpointFingerprint(b))
  assert.equal(await endpointFingerprint(a, null), null, 'no Web Crypto (an insecure page): no fingerprint')
})

test('a sign-up needs an https push address and both keys', () => {
  const keys = { p256dh: 'fake-p256dh', auth: 'fake-auth' }
  assert.deepEqual(parseSubscription({ endpoint: 'https://push.example.invalid/x', expirationTime: null, keys }),
    { endpoint: 'https://push.example.invalid/x', p256dh: 'fake-p256dh', auth: 'fake-auth' })
  for (const bad of [null, 'x', 42, {}, { endpoint: 'https://push.example.invalid/x' }, { keys },
    { endpoint: 'https://push.example.invalid/x', keys: { p256dh: 'k' } },
    { endpoint: 'https://push.example.invalid/x', keys: { p256dh: '', auth: 'a' } },
    { endpoint: 'http://push.example.invalid/x', keys },
    { endpoint: 'javascript:alert(1)', keys },
    { endpoint: 'not a web address', keys },
    { endpoint: `https://push.example.invalid/${'x'.repeat(3000)}`, keys },
    { endpoint: 'https://push.example.invalid/x', keys: { p256dh: 'k'.repeat(600), auth: 'a' } },
    { endpoint: ['https://push.example.invalid/x'], keys }]) {
    assert.equal(parseSubscription(bad), null, JSON.stringify(bad).slice(0, 80))
  }
})

test('the list marks only this device, with the date it was added', () => {
  const devices = [
    { id: 'd1', label: 'iPhone, iPad or Mac (Safari)', addedAt: '2026-10-19T14:05:00.000Z', fingerprint: 'aaaaaaaaaaaa' },
    { id: 'd2', label: 'Chrome', addedAt: '2026-10-20T02:30:00.000Z', fingerprint: 'bbbbbbbbbbbb' },
  ]
  assert.deepEqual(deviceRows(devices, 'bbbbbbbbbbbb'), [
    { id: 'd1', label: 'iPhone, iPad or Mac (Safari)', added: 'Added Oct 19, 2026', isThisDevice: false },
    // 10:30 PM in New York on Oct 19.
    { id: 'd2', label: 'Chrome', added: 'Added Oct 19, 2026', isThisDevice: true },
  ])
  assert.ok(deviceRows(devices, null).every(r => !r.isThisDevice), 'no push sign-up in this browser: none marked')
  assert.ok(deviceRows(devices, 'cccccccccccc').every(r => !r.isThisDevice), 'this browser is not on the list: none marked')
  assert.equal(deviceRows([{ ...devices[0], addedAt: 'garbage' }], null)[0].added, '', 'a bad date shows nothing')
})

test('the note under the list', () => {
  assert.equal(devicesNote(0), NO_DEVICES_MESSAGE)
  assert.match(NO_DEVICES_MESSAGE, /Check In on the Home page/)
  for (const n of [1, 4]) assert.equal(devicesNote(n), 'Up to 5 devices can get notifications.')
  for (const n of [5, 6]) assert.equal(devicesNote(n), "That's the most devices allowed. Remove one before adding another.")
  for (const n of [0, 1, 5]) assert.ok(!/endpoint|subscription|VAPID|!|—/i.test(devicesNote(n)), devicesNote(n))
})

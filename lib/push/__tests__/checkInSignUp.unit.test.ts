// Brief 48 (PR 5, review round 1): Check In sends this browser's sign-up again even
// when it already has one, so a device removed in Settings, or refused at the
// 5-device limit, can get notifications back on its next Check In [engineering
// precaution, found in the PR 5 review]. A refusal shows a calm message instead of
// failing silently. Pure: the browser parts are stand-ins.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHECK_IN_FULL_MESSAGE, signUpOnCheckIn } from '../checkInSignUp'

const SIGN_UP = { endpoint: 'https://push.example.invalid/this-browser', expirationTime: null, keys: { p256dh: 'fake-p256dh', auth: 'fake-auth' } }

function browser(opts: { key?: string; existing?: boolean; permission?: string; status?: number } = {}) {
  const calls: string[] = []
  const sent: unknown[] = []
  const signUp = { toJSON: () => SIGN_UP }
  const deps = {
    publicKey: async () => { calls.push('key'); return opts.key ?? 'fake-public-key' },
    existing: async () => { calls.push('existing'); return opts.existing ? signUp : null },
    requestPermission: async () => { calls.push('permission'); return opts.permission ?? 'granted' },
    subscribe: async (key: string) => { calls.push(`subscribe:${key}`); return signUp },
    send: async (body: unknown) => { calls.push('send'); sent.push(body); return opts.status ?? 200 },
  }
  return { deps, calls, sent }
}

test('a browser that is already signed up sends its sign-up again, with no prompt', async () => {
  const b = browser({ existing: true })
  assert.deepEqual(await signUpOnCheckIn(b.deps), { result: 'sent' })
  assert.deepEqual(b.calls, ['key', 'existing', 'send'])
  assert.deepEqual(b.sent, [SIGN_UP])
})

test('a new browser asks once, signs up with the server key, then sends it', async () => {
  const b = browser()
  assert.deepEqual(await signUpOnCheckIn(b.deps), { result: 'sent' })
  assert.deepEqual(b.calls, ['key', 'existing', 'permission', 'subscribe:fake-public-key', 'send'])
  assert.deepEqual(b.sent, [SIGN_UP])
})

test('no permission, or push not set up on the server: nothing is sent', async () => {
  const denied = browser({ permission: 'denied' })
  assert.deepEqual(await signUpOnCheckIn(denied.deps), { result: 'no-permission' })
  assert.deepEqual(denied.sent, [])
  const noKey = browser({ key: '' })
  assert.deepEqual(await signUpOnCheckIn(noKey.deps), { result: 'not-set-up' })
  assert.deepEqual(noKey.calls, ['key'])
})

test('refused at the device limit: a calm message, and the next Check In tries again', async () => {
  const b = browser({ existing: true, status: 409 })
  assert.deepEqual(await signUpOnCheckIn(b.deps), { result: 'full', message: CHECK_IN_FULL_MESSAGE })
  assert.match(CHECK_IN_FULL_MESSAGE, /5 devices/)
  assert.match(CHECK_IN_FULL_MESSAGE, /Remove one in Settings, then Check In again/)
  assert.ok(!/endpoint|subscription|VAPID|organi[sz]ation|!|—/i.test(CHECK_IN_FULL_MESSAGE), CHECK_IN_FULL_MESSAGE)
  // Sent again on the next Check In: the browser keeps its sign-up (nothing cancels it).
  const again = browser({ existing: true, status: 200 })
  assert.deepEqual(await signUpOnCheckIn(again.deps), { result: 'sent' })
})

test('any other server answer is a quiet failure', async () => {
  for (const status of [400, 500, 503]) {
    assert.deepEqual(await signUpOnCheckIn(browser({ existing: true, status }).deps), { result: 'failed' })
  }
})

test('the Home page Check In uses it, and no longer stops when the browser is already signed up', () => {
  const src = readFileSync(join(__dirname, '..', '..', '..', 'app', 'page.tsx'), 'utf8')
  const fn = src.slice(src.indexOf('async function subscribeToPushIfNeeded'), src.indexOf('async function handleCheckIn'))
  assert.ok(fn.includes('signUpOnCheckIn('), 'Check In calls signUpOnCheckIn')
  assert.ok(!/if \(existing\) return/.test(fn), 'the early return is gone')
  assert.ok(/showToast\(outcome\.message\)/.test(fn), 'a refusal is shown')
})

// Brief 48 (PR 5): the realtime HOT alert follows the digest's rule. Its push text
// is a count, with no buyer's or homeowner's name and no address [planner, Brief 48
// §3 PR 5]. It fires only from the email intake, which is paused [Ryan, 2026-09-24].
// Its switch, its 5-an-hour cap and its PUSH_SENT row stay as they were. Runs on
// stand-ins for Prisma and web-push (nothing is sent); every detail is invented.
import { ORG, assertNoPrivateDetails, db, installFakeWebPush, resetDb, sent } from './pushFakes'
import { test } from 'node:test'
import assert from 'node:assert/strict'

installFakeWebPush()

const DEVICE = {
  id: 'dev-1', organizationId: ORG, endpoint: 'https://push.example.invalid/device-1',
  p256dh: 'fake-p256dh-1', auth: 'fake-auth-1', createdAt: new Date('2026-10-01T12:00:00Z'),
}
// What the one caller (lib/backgroundSync.ts) used to hand over. Passed as a value, so
// the test still type-checks once the alert stops taking a name and a label.
const OLD_STYLE_INPUT = {
  organizationId: ORG, matchId: 'match-b48-hot',
  partyName: 'Morgan Madeup', listingLabel: '742 Fictional Blvd $1.2M Bushwick, call (718) 555-0142',
}

test('the HOT alert names no one and shows no address or phone number', async () => {
  resetDb({ pushSubscription: [{ ...DEVICE }] })
  const { maybeFireHotAlert } = await import('../hotAlert')
  assert.equal(await maybeFireHotAlert(OLD_STYLE_INPUT), true)
  assert.equal(sent.length, 1)
  assertNoPrivateDetails(sent[0].title, 'title')
  assertNoPrivateDetails(sent[0].body, 'body')
  assert.equal(sent[0].title, 'New Hot match')
  assert.equal(sent[0].body, '1 new Hot match. Open DealFlow.')
  assert.equal(sent[0].url, '/matches?m=match-b48-hot', 'a tap still opens the match')
})

test('the HOT alert still logs its send, honours its switch and its hourly cap', async () => {
  const { maybeFireHotAlert } = await import('../hotAlert')

  resetDb({ pushSubscription: [{ ...DEVICE }] })
  await maybeFireHotAlert({ organizationId: ORG, matchId: 'match-b48-hot' })
  const row = (db.tables.auditLog ?? []).find(r => r.action === 'PUSH_SENT')
  assert.deepEqual(
    { kind: (row?.detailsJson as Record<string, unknown>).kind, matchId: (row?.detailsJson as Record<string, unknown>).matchId },
    { kind: 'realtime', matchId: 'match-b48-hot' },
  )

  resetDb({
    pushSubscription: [{ ...DEVICE }],
    notificationPreferences: [{ id: 'np-1', organizationId: ORG, digestEnabled: true, realtimeEnabled: false }],
  })
  assert.equal(await maybeFireHotAlert({ organizationId: ORG, matchId: 'match-b48-hot' }), false)
  assert.equal(sent.length, 0, 'switched off: nothing sent')

  const hourAgo = Date.now() - 30 * 60_000
  resetDb({
    pushSubscription: [{ ...DEVICE }],
    auditLog: Array.from({ length: 5 }, (_, i) => ({
      id: `a-${i}`, organizationId: ORG, action: 'PUSH_SENT', createdAt: new Date(hourAgo + i), detailsJson: { kind: 'realtime', delivered: 1 },
    })),
  })
  const { warn } = console
  console.warn = () => {}
  try {
    assert.equal(await maybeFireHotAlert({ organizationId: ORG, matchId: 'match-b48-hot' }), false)
  } finally { console.warn = warn }
  assert.equal(sent.length, 0, 'over the hourly cap: nothing sent')
})

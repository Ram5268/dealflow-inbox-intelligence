// Brief 48 (PR 5): the morning digest's push text is counts only. It never names a
// buyer or a homeowner, never shows an address and has no run of 10 digits, whatever
// the matched records hold [planner, Brief 48 §3 PR 5]. A quiet morning no longer
// says "Inbox synced Xd ago": email reading is paused [Ryan], so that line
// wasn't true. The switch, the dismissal filter, the PUSH_SENT row and the cron check
// stay as they were. Runs on stand-ins for Prisma and web-push (nothing is sent);
// every name, address and phone number is invented.
import { ORG, OTHER_ORG, assertNoPrivateDetails, db, installFakeWebPush, resetDb, sent, type Row } from '@/lib/push/__tests__/pushFakes'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const CRON = 'b48-test-cron-placeholder'
process.env.CRON_SECRET = CRON
installFakeWebPush()

const DEVICES = [1, 2].map(n => ({
  id: `dev-${n}`, organizationId: ORG, endpoint: `https://push.example.invalid/device-${n}`,
  p256dh: `fake-p256dh-${n}`, auth: `fake-auth-${n}`, createdAt: new Date(`2026-10-0${n}T12:00:00Z`),
}))
// Homeowners from the CRM, buyers from emails, and a listing from an email: exactly
// what the old text could show (a name, an address, a phone number in a title).
const MOJO = [
  { id: 'mc-1', fullName: 'Morgan Madeup', address: '742 Fictional Blvd', neighborhood: 'Bushwick', phone: '(718) 555-0142', tags: [] },
  { id: 'mc-2', fullName: 'Avery Notreal', address: '31 Imaginary Ln', neighborhood: 'Crown Heights', phone: '917.555.0123', tags: [] },
]
const OPPS = [
  { id: 'eo-b1', category: 'BUYER_ISO', sourceAgentName: null, extractedTitle: 'Quinn Fictional (718) 555-0167 wants a 2-family', address: null, neighborhood: null },
  { id: 'eo-b2', category: 'BUYER_ISO', sourceAgentName: 'Robin Placeholder', extractedTitle: 'Investor buyer, 646 555 0188', address: null, neighborhood: null },
  {
    id: 'eo-l1', category: 'ACTIVE_SALE_LISTING', sourceAgentName: 'Sam Inventedname', extractedTitle: '19 Pretend Pl, call 347-555-0199',
    address: '19 Pretend Pl', neighborhood: 'Park Slope', price: 1_250_000, minPrice: null, maxPrice: null,
  },
]

function match(id: string, tier: string, score: number, counterpartType: string, counterpartId: string, opportunityId: string, opportunityType: string, extra: Row = {}): Row {
  return { id, organizationId: ORG, tier, score, counterpartType, counterpartId, opportunityId, opportunityType, createdAt: new Date(), ...extra }
}
// Today: 1 Hot, 2 Warm. The best is a buyer from an email on a homeowner's home.
const TODAY = () => [
  match('m-hot', 'HOT', 95, 'opportunity', 'eo-b1', 'mc-1', 'contact'),
  match('m-warm-1', 'WARM', 72, 'opportunity', 'eo-b2', 'mc-2', 'contact'),
  match('m-warm-2', 'WARM', 70, 'mojo', 'mc-2', 'eo-l1', 'opportunity'),
]
// Never counted: yesterday's, a showing confirmation, another organization's.
const NOT_TODAY = () => [
  match('m-old', 'HOT', 99, 'opportunity', 'eo-b1', 'mc-2', 'contact', { createdAt: new Date(Date.now() - 36 * 3_600_000) }),
  match('m-show', 'HOT', 90, 'showing_confirmation', 'eo-l1', 'eo-l1', 'opportunity'),
  match('m-other', 'HOT', 97, 'opportunity', 'eo-b1', 'mc-1', 'contact', { organizationId: OTHER_ORG }),
]

function seed(matches: Row[], extra: Record<string, Row[]> = {}) {
  resetDb({ pushSubscription: DEVICES.map(d => ({ ...d })), match: matches, mojoContact: MOJO, extractedOpportunity: OPPS, matchDismissal: [], ...extra })
}

async function runDigest(authorization: string | null = `Bearer ${CRON}`) {
  const { GET } = await import('../digest/route')
  const res = await GET(new NextRequest('http://localhost/api/push/digest', { headers: authorization ? { authorization } : {} }))
  return { status: res.status, json: await res.json() as Row }
}

test('the digest names no buyer or homeowner and shows no address or phone number', async () => {
  seed([...TODAY(), ...NOT_TODAY()])
  const { status } = await runDigest()
  assert.equal(status, 200)
  assert.equal(sent.length, 2, 'one push per device')
  for (const p of sent) {
    assertNoPrivateDetails(p.title, 'title')
    assertNoPrivateDetails(p.body, 'body')
    assert.equal(p.title, 'Morning matches')
    assert.equal(p.body, '3 new matches overnight: 1 Hot, 2 Warm. Open DealFlow.')
    assert.equal(p.url, '/matches?m=m-hot', 'a tap still opens the best match')
  }
})

test('the same holds when the best match is a homeowner contact on an email listing', async () => {
  seed([TODAY()[2]])
  await runDigest()
  assert.equal(sent.length, 2)
  for (const p of sent) {
    assertNoPrivateDetails(`${p.title} ${p.body}`, 'push')
    assert.equal(p.body, '1 new match overnight: 1 Warm. Open DealFlow.')
  }
})

test('no name, address or listing is looked up for the digest', async () => {
  seed([...TODAY(), ...NOT_TODAY()])
  await runDigest()
  const lookups = db.calls.filter(c => c.model === 'mojoContact' || c.model === 'extractedOpportunity')
  assert.deepEqual(lookups.map(c => `${c.model}.${c.op}`), [])
})

test('dismissed pairs are still left out of the counts', async () => {
  seed(TODAY(), { matchDismissal: [{ id: 'd-1', partyId: 'eo-b2', listingId: 'mc-2' }] })
  await runDigest()
  assert.equal(sent[0].body, '2 new matches overnight: 1 Hot, 1 Warm. Open DealFlow.')
})

test('a quiet morning says so plainly, with nothing about the inbox', async () => {
  seed(NOT_TODAY(), {
    auditLog: [{ id: 'a-sync', organizationId: ORG, action: 'BACKGROUND_SYNC', detailsJson: {}, createdAt: new Date(Date.now() - 3 * 86_400_000) }],
  })
  const { json } = await runDigest()
  assert.equal(sent.length, 2)
  for (const p of sent) {
    assert.equal(p.title, 'Quiet morning')
    assert.equal(p.body, 'No new matches overnight. Open DealFlow.')
    assert.ok(!/inbox|synced/i.test(`${p.title} ${p.body}`), 'the paused inbox is not mentioned')
    assert.equal(p.url, '/matches')
  }
  assert.ok(!db.calls.some(c => c.model === 'auditLog' && c.op === 'findFirst'), 'the old inbox-sync lookup is gone')
  assert.equal((json.results as Row[])[0].reason, 'quiet')
})

test('the digest switch is still honoured', async () => {
  seed(TODAY(), { notificationPreferences: [{ id: 'np-1', organizationId: ORG, digestEnabled: false, realtimeEnabled: true }] })
  const { json } = await runDigest()
  assert.equal(sent.length, 0)
  assert.equal((json.results as Row[])[0].reason, 'digest disabled')
})

test('every send is still logged as PUSH_SENT', async () => {
  seed(TODAY())
  await runDigest()
  const rows = (db.tables.auditLog ?? []).filter(r => r.action === 'PUSH_SENT')
  assert.equal(rows.length, 1)
  const d = rows[0].detailsJson as Row
  assert.equal(d.kind, 'digest')
  assert.equal(d.delivered, 2)
  assert.equal(d.matchCount, 3)
})

test('the cron check is unchanged: no or a wrong bearer, nothing is sent', async () => {
  seed(TODAY())
  assert.equal((await runDigest(null)).status, 401)
  assert.equal((await runDigest('Bearer not-it')).status, 401)
  assert.equal(sent.length, 0)
})

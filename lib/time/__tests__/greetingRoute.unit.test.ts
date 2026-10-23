// Brief 48 (PR 4): "overnight" on Home counts from New York midnight [planner; Brief 46 S1]. The greeting
// route used setHours(0, 0, 0, 0), which is midnight on the server's own clock: UTC on Vercel, so it
// counted from 8 PM New York time the evening before (7 PM in winter). On a stand-in for Prisma (no
// database, no network), with the computer's clock fixed and its time zone set to UTC, as on Vercel,
// and then to other zones, which must not matter.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

type Args = { where?: Record<string, unknown> }
const calls: Array<{ model: string; op: string; args: Args }> = []

// lib/prisma uses globalThis.prisma when it is set, so no database client is created.
// The route is imported inside the tests, after this runs.
;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy({}, {
  get: (_t, model) => typeof model !== 'string' ? undefined : new Proxy({}, {
    get: (_u, op) => typeof op !== 'string' ? undefined : async (args: Args = {}) => {
      calls.push({ model, op, args })
      if (op === 'count') return 3
      if (op === 'findFirst') return null
      throw new Error(`stand-in: ${model}.${op} is not a read`)
    },
  }),
})
globalThis.fetch = (() => { throw new Error('network refused in this test') }) as typeof fetch

const gte = (model: string, field: string): string | undefined => {
  const call = calls.find(c => c.model === model && c.op === 'count' && c.args.where && field in c.args.where)
  const value = (call?.args.where?.[field] as { gte?: Date } | undefined)?.gte
  return value instanceof Date ? value.toISOString() : undefined
}

async function overnightSince(now: string, tz: string) {
  const before = process.env.TZ
  process.env.TZ = tz
  mock.timers.enable({ apis: ['Date'], now: new Date(now) })
  calls.length = 0
  try {
    const { GET } = await import('../../../app/api/user/greeting/route')
    const res = await GET()
    return { emails: gte('rawEmail', 'receivedDateTime'), opps: gte('extractedOpportunity', 'createdAt'), body: await res.json() }
  } finally {
    mock.timers.reset()
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
}

// [what, now, New York midnight that "overnight" counts from]
const CASES: Array<[string, string, string]> = [
  ['10 AM in New York (summer)', '2026-10-19T14:00:00.000Z', '2026-10-19T04:00:00.000Z'],
  ['11:30 PM in New York, already the next day in UTC', '2026-10-19T03:30:00.000Z', '2026-10-18T04:00:00.000Z'],
  ['just after New York midnight', '2026-10-19T04:00:01.000Z', '2026-10-19T04:00:00.000Z'],
  ['10 AM in New York (winter)', '2026-12-15T15:00:00.000Z', '2026-12-15T05:00:00.000Z'],
  ['the day the clocks go back (Nov 1)', '2026-11-01T15:00:00.000Z', '2026-11-01T04:00:00.000Z'],
  ['the day the clocks go forward (Mar 8)', '2026-03-08T15:00:00.000Z', '2026-03-08T05:00:00.000Z'],
]

test('overnight emails and listings count from New York midnight on a UTC server (Vercel)', async () => {
  for (const [what, now, midnight] of CASES) {
    const { emails, opps } = await overnightSince(now, 'UTC')
    assert.equal(emails, midnight, `${what}: emails`)
    assert.equal(opps, midnight, `${what}: listings`)
  }
})

test('the server\'s own time zone doesn\'t matter', async () => {
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'America/New_York']) {
    for (const [what, now, midnight] of CASES) {
      const { emails, opps } = await overnightSince(now, tz)
      assert.equal(emails, midnight, `${what}, server in ${tz}: emails`)
      assert.equal(opps, midnight, `${what}, server in ${tz}: listings`)
    }
  }
})

test('the greeting route still only reads, and answers with the same fields', async () => {
  const { body } = await overnightSince('2026-10-19T14:00:00.000Z', 'UTC')
  assert.deepEqual(Object.keys(body).sort(), [
    'lastSync', 'newMatches', 'newShowingConfirmations', 'overnightEmails', 'overnightOpps', 'pendingReviewCount', 'totalOpps',
  ])
  assert.equal(body.overnightEmails, 3)
  assert.ok(calls.every(c => c.op === 'count' || c.op === 'findFirst'), 'reads only')
})

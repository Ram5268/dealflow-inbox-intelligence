// Brief 48 (PR 2): two leftover open web addresses [planner, Brief 48].
// - GET /api/debug (an Outlook check on one hard-coded email) is deleted. Its
//   health and guard-fires children are Brief 47's and stay.
// - POST /api/sync/reprocess-attachments (fetches from Outlook the attachments of
//   every email with no saved attachment text, and saves that text) is a
//   maintenance route: off unless MAINTENANCE_ENABLED is exactly 'true', checked
//   before anything else.
// Pure: an in-memory stand-in for Prisma that records any use and fails it, and
// the network refused. The route is imported after the stand-in is in place.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MAINTENANCE_OFF_BODY } from '../config/maintenance'
import { GRAPH_PAUSED_MESSAGE } from '../graphAccess'

const ROOT = join(__dirname, '..', '..')

// lib/prisma uses globalThis.prisma when it is set, so no database client is created.
const touched: string[] = []
;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy({}, {
  get: (_t, model) => {
    if (typeof model !== 'string') return undefined
    touched.push(model)
    return new Proxy({}, { get: () => async () => { throw new Error(`stand-in: prisma.${model} must not be used`) } })
  },
})
const fetched: string[] = []
globalThis.fetch = (async (input: unknown) => {
  fetched.push(String(input))
  throw new Error('no network in this test')
}) as typeof fetch

const SWITCHES = ['MAINTENANCE_ENABLED', 'INGESTION_TEST_MODE_ONLY', 'GRAPH_ENABLED'] as const
type Switches = Partial<Record<(typeof SWITCHES)[number], string>>

// POST with exactly these switches set (the rest unset), then put the env back.
async function reprocess(env: Switches) {
  const prev = SWITCHES.map(k => [k, process.env[k]] as const)
  for (const k of SWITCHES) {
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  }
  touched.length = 0
  fetched.length = 0
  try {
    const { POST } = await import('../../app/api/sync/reprocess-attachments/route')
    const res = await POST()
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

test('GET /api/debug is gone', () => {
  const routeFiles = readdirSync(join(ROOT, 'app/api/debug')).filter(f => /^route\./.test(f))
  assert.deepEqual(routeFiles, [])
})

test('reprocess-attachments is off unless MAINTENANCE_ENABLED is exactly "true": no database, no Outlook', async () => {
  for (const v of [undefined, '', 'false', 'TRUE', '1']) {
    // Even with Outlook switched on, the maintenance switch answers first.
    const r = await reprocess({ MAINTENANCE_ENABLED: v, GRAPH_ENABLED: 'true' })
    assert.equal(r.status, 403, JSON.stringify(v))
    assert.deepEqual(r.body, MAINTENANCE_OFF_BODY)
    assert.deepEqual(touched, [], JSON.stringify(v))
    assert.deepEqual(fetched, [], JSON.stringify(v))
  }
})

test('with maintenance on, the older switches still stop it: ingestion test mode, then the Outlook pause', async () => {
  const testMode = await reprocess({ MAINTENANCE_ENABLED: 'true', INGESTION_TEST_MODE_ONLY: 'true', GRAPH_ENABLED: 'true' })
  assert.equal(testMode.status, 423)
  assert.deepEqual([touched, fetched], [[], []])

  const paused = await reprocess({ MAINTENANCE_ENABLED: 'true' })
  assert.equal(paused.status, 401)
  assert.ok(String(paused.body.error).includes(GRAPH_PAUSED_MESSAGE), String(paused.body.error))
  assert.deepEqual([touched, fetched], [[], []])
})

// Brief 41 (H10) — the Outlook / Microsoft Graph off-switch. Pure: no DB, no
// network. getToken() in lib/microsoftGraph.ts is a thin wrapper around
// resolveGraphToken() with the Prisma and fetch pieces passed in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { graphEnabled, resolveGraphToken, GraphDisabledError, type GraphTokenDeps, type StoredGraphToken } from '../graphAccess'

const ROOT = join(__dirname, '..', '..')
const HOUR = 3_600_000

function spyDeps(stored: StoredGraphToken | null, refreshed: string | null = 'fresh-token', env: string | null = 'env-token') {
  const calls = { loadStored: 0, refresh: 0, envToken: 0 }
  const deps: GraphTokenDeps = {
    loadStored: async () => { calls.loadStored++; return stored },
    refresh: async () => { calls.refresh++; return refreshed },
    envToken: () => { calls.envToken++; return env ?? undefined },
    now: () => Date.parse('2026-10-05T12:00:00Z'),
  }
  return { deps, calls }
}
const expired: StoredGraphToken = { accessTokenEncrypted: 'stale-token', refreshTokenEncrypted: 'refresh-token', lastSyncAt: new Date(Date.parse('2026-10-05T12:00:00Z') - HOUR) }
const valid: StoredGraphToken = { ...expired, accessTokenEncrypted: 'valid-token', lastSyncAt: new Date(Date.parse('2026-10-05T12:00:00Z') + HOUR) }

async function withSwitch(value: string | undefined, fn: () => Promise<void>) {
  const prev = process.env.GRAPH_ENABLED
  if (value === undefined) delete process.env.GRAPH_ENABLED
  else process.env.GRAPH_ENABLED = value
  try { await fn() } finally {
    if (prev === undefined) delete process.env.GRAPH_ENABLED
    else process.env.GRAPH_ENABLED = prev
  }
}

test('no token, no DB read, no refresh, no stale or env fallback unless GRAPH_ENABLED is exactly "true"', async () => {
  for (const value of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'true ']) {
    await withSwitch(value, async () => {
      assert.equal(graphEnabled(), false, `GRAPH_ENABLED=${JSON.stringify(value)}`)
      for (const stored of [expired, valid, null]) {
        const { deps, calls } = spyDeps(stored)
        await assert.rejects(resolveGraphToken(deps), GraphDisabledError)
        assert.deepEqual(calls, { loadStored: 0, refresh: 0, envToken: 0 }, `GRAPH_ENABLED=${JSON.stringify(value)}`)
      }
    })
  }
})

test('with GRAPH_ENABLED=true the lookup behaves as before (valid, refresh, stale, env)', async () => {
  await withSwitch('true', async () => {
    assert.equal(graphEnabled(), true)
    let s = spyDeps(valid)
    assert.equal(await resolveGraphToken(s.deps), 'valid-token')
    assert.equal(s.calls.refresh, 0)
    s = spyDeps(expired)
    assert.equal(await resolveGraphToken(s.deps), 'fresh-token')
    assert.equal(s.calls.refresh, 1)
    s = spyDeps(expired, null)
    assert.equal(await resolveGraphToken(s.deps), 'stale-token')
    s = spyDeps(null)
    assert.equal(await resolveGraphToken(s.deps), 'env-token')
    s = spyDeps(null, null, null)
    await assert.rejects(resolveGraphToken(s.deps), /No Microsoft Graph token found/)
  })
})

test('getToken() checks the switch before anything else', () => {
  const src = readFileSync(join(ROOT, 'lib/microsoftGraph.ts'), 'utf8')
  const body = src.slice(src.indexOf('export async function getToken'))
  assert.equal(body.split('\n')[1].trim(), 'if (!graphEnabled()) throw new GraphDisabledError()')
  assert.match(body, /return resolveGraphToken\(/)
})

// Belt and braces on top of getToken(): every route that talks to Microsoft,
// installs a Microsoft token or writes a calendar event checks the switch itself.
const GUARDED_ROUTES = [
  'app/api/auth/callback/route.ts',
  'app/api/auth/microsoft/route.ts',
  'app/api/calendar/today/route.ts',
  'app/api/matches/[id]/schedule-showing/route.ts',
  'app/api/microsoft/device-code/poll/route.ts',
  'app/api/microsoft/device-code/route.ts',
  'app/api/microsoft/messages-preview/route.ts',
  'app/api/microsoft/test/route.ts',
  'app/api/microsoft/token/route.ts',
]

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? routeFiles(p) : name === 'route.ts' ? [p] : []
  })
}

test('every Microsoft route checks graphEnabled()', () => {
  for (const f of GUARDED_ROUTES) {
    assert.match(readFileSync(join(ROOT, f), 'utf8'), /\bgraphEnabled\(\)/, f)
  }
})

test('no other API route reaches Microsoft or stores a Microsoft token directly', () => {
  const direct = /login\.microsoftonline\.com|graph\.microsoft\.com\/v1\.0|connectedMailbox\.(upsert|create|update)\b|createCalendarEvent\(/
  const offenders = routeFiles(join(ROOT, 'app', 'api'))
    .map(p => relative(ROOT, p))
    .filter(f => direct.test(readFileSync(join(ROOT, f), 'utf8')))
    .filter(f => !GUARDED_ROUTES.includes(f) && f !== 'app/api/chat/route.ts')
  assert.deepEqual(offenders, [])
})

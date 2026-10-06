// Brief 41 (H10) — the Outlook / Microsoft Graph off-switch. Pure: no DB, no
// network. getToken() in lib/microsoftGraph.ts is a thin wrapper around
// resolveGraphToken() with the Prisma and fetch pieces passed in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { graphEnabled, resolveGraphToken, GraphDisabledError, GRAPH_PAUSED_CALENDAR_BLOCK, type GraphTokenDeps, type StoredGraphToken } from '../graphAccess'

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

// The first statement of a function body, skipping blank and comment lines.
function firstStatement(src: string, signature: RegExp): string {
  const m = signature.exec(src)
  assert.ok(m, `no ${signature} in source`)
  const after = src.slice(m.index + m[0].length)
  return after.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('//')) ?? ''
}

test('getToken() checks the switch before anything else', () => {
  const src = readFileSync(join(ROOT, 'lib/microsoftGraph.ts'), 'utf8')
  assert.match(firstStatement(src, /export async function getToken\(\)[^{]*\{/), /^if \(!graphEnabled\(\)\) throw new GraphDisabledError\(\)/)
  assert.match(src, /return resolveGraphToken\(/)
})

// Belt and braces on top of getToken(): every route that talks to Microsoft,
// installs a Microsoft token or writes a calendar event checks the switch itself.
const GUARDED_ROUTES = [
  'app/api/user/profile/route.ts',
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

test('every Microsoft route checks graphEnabled() as its first statement', () => {
  for (const f of GUARDED_ROUTES) {
    const src = readFileSync(join(ROOT, f), 'utf8')
    const handlers = [...src.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g)].map(m => m[1])
    assert.ok(handlers.length > 0, f)
    for (const h of handlers) {
      assert.match(firstStatement(src, new RegExp(`export async function ${h}\\b[\\s\\S]*?\\)\\s*\\{\\s*\\n`)), /^if \(!graphEnabled\(\)\)/, `${f} ${h}`)
    }
  }
})

test('Drift is told Outlook is paused on every turn, as its own block', () => {
  assert.match(GRAPH_PAUSED_CALENDAR_BLOCK, /^\n\nCALENDAR: Outlook is paused/)
  assert.match(GRAPH_PAUSED_CALENDAR_BLOCK, /Never offer to book/)
  const fetcher = readFileSync(join(ROOT, 'lib/chat/context/calendar.ts'), 'utf8')
  assert.match(firstStatement(fetcher, /export const calendarFetcher: ContextFetcher = async \([^)]*\) => \{\s*\n/), /^if \(!graphEnabled\(\)\) return \{ block: GRAPH_PAUSED_CALENDAR_BLOCK \}/)
  const route = readFileSync(join(ROOT, 'app/api/chat/route.ts'), 'utf8')
  assert.match(route, /if \(!graphEnabled\(\)\) aiResult\.pendingEvent = null\n\s*const guardEnabled/)
})

test('no other API route reaches Microsoft or stores a Microsoft token directly', () => {
  const direct = /login\.microsoftonline\.com|graph\.microsoft\.com\/(v1\.0|beta)|connectedMailbox\.(upsert|create|createMany|update|updateMany)\b|createCalendarEvent\s*\(|MICROSOFT_GRAPH_ACCESS_TOKEN/
  const offenders = routeFiles(join(ROOT, 'app', 'api'))
    .map(p => relative(ROOT, p))
    .filter(f => direct.test(readFileSync(join(ROOT, f), 'utf8')))
    .filter(f => !GUARDED_ROUTES.includes(f))
  assert.deepEqual(offenders, [])
})

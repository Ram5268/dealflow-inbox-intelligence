// Brief 43 PR 4 (Q4; M32): Drift's side lookups can't hold up a turn. Runs the
// real composeContext and registry on a fake clock, with a stand-in Prisma
// whose CRM-seller query never answers and a fetch that never answers (both
// honour an abort, as real ones do). Nothing leaves this process.
import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'

const never = <T>() => new Promise<T>(() => {})
;(globalThis as unknown as { prisma: unknown }).prisma = {
  // Brief 43 PR 5: the CRM-seller block is a count now (and reads the org id
  // first); both stand in here so the count is the query that never answers.
  organization: { findUnique: async () => ({ id: 'org_test' }) },
  mojoContact: { findMany: () => never(), count: () => never() },
  extractedOpportunity: { findMany: async () => [] },
  match: { findMany: async () => [] },
  rapidApiUsage: {
    upsert: async () => ({ callsConsumed: 0, monthlyBudget: 10_000, pausedAt: null, warnedAt80: false, warnedAt90: false, warnedAt95: false }),
    update: async () => ({}),
  },
}
// Test-only placeholder so the live StreetEasy search runs (its fetch is the fake below).
process.env.RAPIDAPI_KEY = 'test-only-placeholder'
const fetched: string[] = []
globalThis.fetch = ((input: unknown, init?: { signal?: AbortSignal | null }) => {
  fetched.push(String(input).split('?')[0])
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  })
}) as typeof fetch

async function load() {
  const { composeContext } = await import('../composeContext')
  const { parseQuery } = await import('../../../retrieval/queryParser')
  return { composeContext, parseQuery }
}

async function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | 'still waiting'> {
  let out: T | 'still waiting' = 'still waiting'
  p.then(v => { out = v })
  for (let t = 0; t < ms; t += 500) {
    mock.timers.tick(500)
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
    if (out !== 'still waiting') break
  }
  return out
}

afterEach(() => mock.timers.reset())

test('a lookup that never answers is cut off, with a one-line note, and the turn goes on', async () => {
  const { composeContext, parseQuery } = await load()
  const msg = 'my buyer wants a 2br rental in williamsburg under 4k'
  const parsed = await parseQuery(msg)
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-19T15:00:00Z') })
  const out = await settleWithin(composeContext({ parsed, userMessage: msg, queryText: msg, isConfirmMessage: false }), 15_000)
  assert.notEqual(out, 'still waiting', 'composeContext returned within its budget')
  if (out === 'still waiting') return
  assert.ok(Date.now() - Date.parse('2026-10-19T15:00:00Z') <= 10_000, 'within 10 s of fake time')
  assert.ok(fetched.some(u => u.includes('rapidapi.com')), 'the live StreetEasy search was tried')
  // StreetEasy's own fetch gives up at 6 s; the CRM-seller query is cut at 10 s.
  assert.match(out.pre, /live StreetEasy didn't answer in time/)
  assert.match(out.post, /the CRM seller lookup didn't answer in time/)
  // No "no listings found" claim for a search that never answered; the browse link stays.
  assert.doesNotMatch(out.pre, /no matching listings found/)
  assert.match(out.seFilterUrl ?? '', /streeteasy\.com/)
  assert.deepEqual(out.liveSeListings, [])
})

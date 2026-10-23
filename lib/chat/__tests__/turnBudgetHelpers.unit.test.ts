// Brief 43 PR 4 (Q4; M23, M32): the time-budget helpers in lib/chat/turnBudget.ts.
// Pure: a fake clock and a stand-in fetch; nothing leaves this process.
import { test, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  createTurnBudget, withTimeout, isTimedOut, TimedOut, fetchWithTimeout, isLookupTimeout,
  tallyLookupTimeouts, deadlineSignal, lookupTimeoutNote, LOOKUP_TIMEOUT_MS,
  TURN_SOFT_MS, TURN_HARD_MS, TURN_CEILING_MS,
} from '../turnBudget'

afterEach(() => mock.timers.reset())
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }

// A fetch that answers only when told to, and fails on abort as a real one does.
function slowFetch() {
  const calls: Array<{ url: string; answer: () => void }> = []
  globalThis.fetch = ((url: unknown, init?: { signal?: AbortSignal | null }) =>
    new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      calls.push({ url: String(url), answer: () => resolve(new Response('[]', { status: 200 })) })
    })) as typeof fetch
  return calls
}

test('the turn budget: soft at 40 s, hard at 50 s, every model call cut at 52 s', () => {
  assert.equal(TURN_SOFT_MS, 40_000)
  assert.equal(TURN_HARD_MS, 50_000)
  assert.equal(TURN_CEILING_MS, 52_000)
  let now = 1_000
  const b = createTurnBudget(1_000, { softMs: TURN_SOFT_MS, hardMs: TURN_HARD_MS }, () => now)
  assert.equal(b.pastSoft(), false)
  assert.equal(b.msLeft(TURN_CEILING_MS), 52_000)
  now = 1_000 + 39_999
  assert.equal(b.pastSoft(), false)
  now = 1_000 + 40_000
  assert.equal(b.pastSoft(), true)
  assert.equal(b.pastHard(), false)
  assert.equal(b.elapsedMs(), 40_000)
  now = 1_000 + 50_000
  assert.equal(b.pastHard(), true)
  assert.equal(b.msLeft(TURN_CEILING_MS), 2_000)
  now = 1_000 + 70_000
  assert.equal(b.msLeft(TURN_CEILING_MS), 0, 'never negative')
})

test('the budget reads the real clock by default', () => {
  mock.timers.enable({ apis: ['Date'], now: 5_000 })
  const b = createTurnBudget(Date.now(), { softMs: 40_000, hardMs: 50_000 })
  mock.timers.tick(41_000)
  assert.equal(b.pastSoft(), true)
  assert.equal(b.pastHard(), false)
})

test('withTimeout: a fast answer comes through, a slow one becomes TimedOut', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  assert.equal(await withTimeout(Promise.resolve(7), 1_000, 'fast'), 7)
  let out: unknown = 'waiting'
  withTimeout(new Promise(() => {}), 6_000, 'live StreetEasy').then(v => { out = v })
  mock.timers.tick(5_999)
  await flush()
  assert.equal(out, 'waiting')
  mock.timers.tick(1)
  await flush()
  assert.ok(isTimedOut(out))
  assert.ok((out as object) instanceof TimedOut)
  assert.equal((out as TimedOut).label, 'live StreetEasy')
  assert.equal((out as TimedOut).ms, 6_000)
  assert.equal(isTimedOut({ timedOut: true }), false, 'only a real TimedOut counts')
})

test('withTimeout passes a failure through', async () => {
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 1_000, 'x'), /boom/)
})

test('fetchWithTimeout aborts at 6 s with an error that names the host only', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const calls = slowFetch()
  assert.equal(LOOKUP_TIMEOUT_MS, 6_000)
  let err: unknown = null
  fetchWithTimeout('https://api.example.org/series?api_key=test-only-placeholder', {}).catch(e => { err = e })
  await flush()
  assert.equal(calls.length, 1)
  mock.timers.tick(LOOKUP_TIMEOUT_MS)
  await flush()
  assert.ok(isLookupTimeout(err))
  assert.match(String((err as Error).message), /api\.example\.org/)
  assert.doesNotMatch(String((err as Error).message), /api_key|placeholder/, 'no query string (it can carry a key)')
})

test('fetchWithTimeout: a fast answer comes through and is not counted', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const calls = slowFetch()
  const tally = { timeouts: 0 }
  const p = tallyLookupTimeouts(tally, () => fetchWithTimeout('https://data.example.org/x.json', {}, 1_000))
  await flush()
  calls[0].answer()
  const res = await p
  assert.equal(res.status, 200)
  mock.timers.tick(5_000)
  await flush()
  assert.equal(tally.timeouts, 0)
})

test('a timed-out fetch is counted in the scope it ran in, and only there', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  slowFetch()
  const a = { timeouts: 0 }
  const b = { timeouts: 0 }
  const pa = tallyLookupTimeouts(a, () => fetchWithTimeout('https://a.example.org/', {}, 1_000).catch(() => null))
  const pb = tallyLookupTimeouts(b, async () => 'no fetch here')
  const outside = fetchWithTimeout('https://c.example.org/', {}, 1_000).catch(() => null)
  mock.timers.tick(1_000)
  await Promise.all([pa, pb, outside])
  assert.equal(a.timeouts, 1)
  assert.equal(b.timeouts, 0)
})

test("fetchWithTimeout also honours the caller's own signal", async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  slowFetch()
  const mine = new AbortController()
  let err: unknown = null
  fetchWithTimeout('https://a.example.org/', { signal: mine.signal }, 6_000).catch(e => { err = e })
  await flush()
  mine.abort(new Error('caller stopped'))
  await flush()
  assert.match(String(err), /caller stopped/)
  assert.ok(!isLookupTimeout(err))
})

test('deadlineSignal aborts when the time is up', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const d = deadlineSignal(5_000)
  mock.timers.tick(4_999)
  assert.equal(d.signal.aborted, false)
  mock.timers.tick(1)
  assert.equal(d.signal.aborted, true)
  const zero = deadlineSignal(0)
  mock.timers.tick(0)
  assert.equal(zero.signal.aborted, true)
})

test('the note Drift gets for a lookup that ran out of time is one plain line', () => {
  const note = lookupTimeoutNote('live StreetEasy')
  assert.match(note, /live StreetEasy didn't answer in time/)
  assert.equal(note.trim().split('\n').length, 1)
  assert.doesNotMatch(note, /—|!/)
})

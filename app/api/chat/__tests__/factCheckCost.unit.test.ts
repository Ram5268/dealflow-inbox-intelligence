// Brief 43 PR 15 (Q31, Q35, Q37): the fact-check's cost, the spend record and
// the retry reasons, through the real chat route with a stand-in Prisma and
// scripted AI replies (pr3ChatHarness). No database, no network: the live
// StreetEasy search below is refused like every other outside address.
import { db, script, driftCalls, verifierCalls, reset, postChat } from './pr3ChatHarness'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicTool } from '../../../../lib/__tests__/fakeAiFetch'
import { RYAN_MD } from '../../../../lib/prompts/ryanMd'

// The guard-log rows, and a quota row so the live StreetEasy search gets as far
// as its (refused) request. Set before the route loads lib/prisma.
type Row = Record<string, unknown>
const guardRows: Row[] = []
const harnessPrisma = (globalThis as unknown as { prisma: Record<string, unknown> }).prisma
const extra: Record<string, unknown> = {
  guardFireEvent: { create: async ({ data }: { data: Row }) => { guardRows.push(data); return data } },
  rapidApiUsage: {
    upsert: async () => ({ callsConsumed: 0, monthlyBudget: 10_000, pausedAt: null, warnedAt80: false, warnedAt90: false, warnedAt95: false }),
    update: async () => ({}),
  },
}
;(globalThis as unknown as { prisma: unknown }).prisma = new Proxy({}, { get: (_t, model) => extra[String(model)] ?? harnessPrisma[String(model)] })
process.env.RAPIDAPI_KEY = 'test-only-placeholder' // read when lib/streetEasySync loads; its fetch is refused

const reply = (response: string) => anthropicTool('drift_response', { response, suggestions: ['a', 'b'], referencedDeals: [] })
const USAGE = { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 5000 }
const withUsage = (m: Row) => ({ ...m, usage: USAGE })
const parsedFilters = () => db.interactions[0].parsedFilters as Row & { guard: { history: Array<Row> }; usage: Record<string, Row> }
const verifierInput = (i: number) => String((verifierCalls[i].body.messages as Array<{ content: unknown }>)[0].content)
const marks = (v: unknown): number => {
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + marks(x), 0)
  if (v && typeof v === 'object') return Object.entries(v).reduce((n, [k, x]) => n + (k === 'cache_control' && x ? 1 : marks(x)), 0)
  return 0
}
type Block = { type: string; cache_control?: unknown }
const toolResultMarks = (i: number) => (driftCalls[i].body.messages as Array<{ content: unknown }>)
  .flatMap(m => (Array.isArray(m.content) ? m.content as Block[] : []))
  .filter(b => b.type === 'tool_result')
  .map(b => Boolean(b.cache_control))

beforeEach(() => { reset(); guardRows.length = 0 })

test('"thanks" gets no fact-check; the guard row and the spend record say so', async () => {
  script.push(reply("You're welcome, Ryan."))
  const { status, json } = await postChat({ message: 'thanks' })
  assert.equal(status, 200)
  assert.equal(json.response, "You're welcome, Ryan.")
  assert.equal(verifierCalls.length, 0, 'no fact-check call')
  assert.equal(parsedFilters().guard.history[0].verifierSkipped, 'fact_free')
  assert.equal(guardRows[0].verifierVerdict, 'pass')
  assert.equal((parsedFilters().deadline as Row).factCheckSkipped, false, 'not a deadline skip')
})

test('a reply with a price is fact-checked, and the fact-check no longer gets RYAN_MD', async () => {
  script.push(reply("It's asking $1,850,000."))
  await postChat({ message: 'what is it asking?' })
  assert.equal(verifierCalls.length, 1)
  const input = verifierInput(0)
  assert.ok(!input.includes(RYAN_MD.slice(0, 120)), "RYAN_MD's opening is not in the fact-check's input")
  assert.ok(!input.includes(RYAN_MD.slice(-120)), "nor its end")
  // This turn's side-lookup text still is (the calendar's paused note).
  assert.match(input, /<side_channel_context grounded="true">[\s\S]*Outlook is paused/)
})

test('a side lookup (live StreetEasy) keeps the fact-check on a plain reply, and the guard row counts the search', async () => {
  script.push(reply("I couldn't find a match for that yet."))
  await postChat({ message: 'my buyer wants a 2br rental in williamsburg under 4k' })
  assert.equal(verifierCalls.length, 1)
  const calls = guardRows[0].toolCallsAttempted as Row[]
  assert.deepEqual(calls.filter(c => c.name === 'streeteasy_search'), [{ name: 'streeteasy_search', searches: 1, listings: 0 }])
})

test('the cache breakpoint lands on the last tool result, at most 4 per request', async () => {
  script.push(
    anthropicTool('search_listings', { neighborhoods: ['Crown Heights'] }),
    anthropicTool('search_parties', { role: 'buyer' }),
    reply('Nothing on file for that yet.'),
  )
  await postChat({ message: 'anything in Crown Heights, and who is looking there?' })
  assert.equal(driftCalls.length, 3)
  assert.deepEqual(toolResultMarks(0), [], 'round 1: no tool result yet')
  assert.deepEqual(toolResultMarks(1), [true], 'round 2: the only result is marked')
  assert.deepEqual(toolResultMarks(2), [false, true], 'round 3: only the newest result is marked')
  for (let i = 0; i < driftCalls.length; i++) {
    const n = marks({ system: driftCalls[i].body.system, tools: driftCalls[i].body.tools, messages: driftCalls[i].body.messages })
    assert.ok(n <= 4, `call ${i}: ${n} breakpoints`)
    assert.equal(n, i === 0 ? 2 : 3, `call ${i}`)
  }
})

test('costUsd counts cache writes and reads and the fact-check, at Sonnet 4.6 prices', async () => {
  script.push(withUsage(anthropicTool('search_listings', { neighborhoods: ['Crown Heights'] })), withUsage(reply("It's asking $1,850,000.")))
  await postChat({ message: 'anything in Crown Heights?' })
  assert.equal(verifierCalls.length, 1)
  const row = db.interactions[0] as Row
  // Two Drift calls at (1000×$3 + 100×$15 + 2000×$3.75 + 5000×$0.30) per million,
  // plus the fact-check's 1 token in and 1 out (the harness's reply).
  const expected = 2 * (3000 + 1500 + 7500 + 1500) / 1e6 + (3 + 15) / 1e6
  assert.ok(Math.abs((row.costUsd as number) - expected) < 1e-12, `${row.costUsd} vs ${expected}`)
  assert.equal(row.tokensIn, 2000, 'tokensIn: uncached input, as before')
  assert.equal(row.tokensOut, 200)
  const usage = parsedFilters().usage
  assert.deepEqual(
    { calls: usage.main.calls, cacheCreationTokens: usage.main.cacheCreationTokens, cacheReadTokens: usage.main.cacheReadTokens },
    { calls: 2, cacheCreationTokens: 4000, cacheReadTokens: 10000 },
  )
  assert.equal(usage.reports.calls, 0)
})

test('a retry that ends clean records why it retried', async () => {
  script.push(reply('Sent. The text is on its way.'), reply("I can't send texts. The draft is ready to copy."))
  const { json } = await postChat({ message: 'text the buyer for me' })
  assert.equal(json.response, "I can't send texts. The draft is ready to copy.")
  assert.equal(guardRows[0].verifierVerdict, 'retry')
  assert.match(String(guardRows[0].verifierReason), /\(action_claim\)/)
})

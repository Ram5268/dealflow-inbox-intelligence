// Brief 43 PR 15 (Q37): the cost maths behind DriftInteraction.costUsd, which
// PR 17's daily cap sums. Cache writes and reads are priced, and the report
// section's Sonnet call and the fact-checks are counted. Pure; the fake client
// never reaches the network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type Anthropic from '@anthropic-ai/sdk'
import { newUsageTally, addUsage, tallyCostUsd, turnCostUsd, usageRecord, countingClient } from '../turnCost'

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`)

test('each kind of token at its Sonnet 4.6 price: $3 in, $15 out, $3.75 cache write, $0.30 cache read (per million)', () => {
  const t = newUsageTally()
  addUsage(t, { input_tokens: 1_000_000, output_tokens: 0 })
  close(tallyCostUsd(t), 3)
  const out = newUsageTally(); addUsage(out, { input_tokens: 0, output_tokens: 1_000_000 }); close(tallyCostUsd(out), 15)
  const w = newUsageTally(); addUsage(w, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 }); close(tallyCostUsd(w), 3.75)
  const r = newUsageTally(); addUsage(r, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 }); close(tallyCostUsd(r), 0.3)
})

test('calls add up; a missing or null cache field counts as 0', () => {
  const t = newUsageTally()
  addUsage(t, { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 5000 })
  addUsage(t, { input_tokens: 500, output_tokens: 50, cache_creation_input_tokens: null, cache_read_input_tokens: null })
  addUsage(t, null) // a call with no usage still counts as a call
  assert.deepEqual(t, { calls: 3, inputTokens: 1500, outputTokens: 150, cacheCreationTokens: 2000, cacheReadTokens: 5000 })
  // 1500×3 + 150×15 + 2000×3.75 + 5000×0.30, per million
  close(tallyCostUsd(t), (4500 + 2250 + 7500 + 1500) / 1e6)
})

test("Brief 46's warm \"thanks\" turn: the old formula saw a fraction of it", () => {
  // drift-2's p5-cost model: a 7,400-token cached prefix read, ~600 uncached, ~260 out.
  const t = newUsageTally()
  addUsage(t, { input_tokens: 600, output_tokens: 260, cache_read_input_tokens: 7_400 })
  const old = (600 / 1e6) * 3 + (260 / 1e6) * 15
  close(tallyCostUsd(t), old + (7_400 / 1e6) * 0.3)
  assert.ok(tallyCostUsd(t) > old)
})

test("the turn's cost: Drift's calls, the report-section calls and the fact-checks", () => {
  const main = newUsageTally(); addUsage(main, { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 5000 })
  const reports = newUsageTally(); addUsage(reports, { input_tokens: 300, output_tokens: 120 })
  const total = turnCostUsd({ main, reports, verifierCostUsd: 0.012 })
  close(total, (3000 + 1500 + 1500) / 1e6 + (900 + 1800) / 1e6 + 0.012)
  const rec = usageRecord({ main, reports, verifierCostUsd: 0.012 })
  assert.equal(rec.main.calls, 1)
  assert.equal(rec.main.cacheReadTokens, 5000)
  close(rec.main.costUsd, 0.006)
  close(rec.reports.costUsd, 0.0027)
  close(rec.verifierCostUsd, 0.012)
  close(rec.totalUsd, total)
  // Counts and dollars only: no message text.
  assert.deepEqual(Object.keys(rec).sort(), ['main', 'reports', 'totalUsd', 'verifierCostUsd'])
})

test("countingClient adds a report section's Sonnet call to the tally and passes everything else through", async () => {
  const reply = { id: 'msg_x', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Widen the budget.' }], usage: { input_tokens: 310, output_tokens: 90, cache_creation_input_tokens: null, cache_read_input_tokens: null } }
  const seen: unknown[] = []
  const fake = {
    apiKey: 'test-only-placeholder',
    messages: {
      create: async (args: unknown) => { seen.push(args); return reply },
      countTokens: async () => ({ input_tokens: 7 }),
    },
  }
  const tally = newUsageTally()
  const client = countingClient(fake as unknown as Anthropic, tally)
  const got = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: 'x' }] })
  assert.equal(got, reply as unknown)
  assert.equal(seen.length, 1)
  assert.deepEqual(tally, { calls: 1, inputTokens: 310, outputTokens: 90, cacheCreationTokens: 0, cacheReadTokens: 0 })
  assert.equal((client as unknown as typeof fake).apiKey, 'test-only-placeholder')
  assert.deepEqual(await (client.messages as unknown as typeof fake.messages).countTokens(), { input_tokens: 7 })
  assert.equal(tally.calls, 1, 'only create is counted')
})

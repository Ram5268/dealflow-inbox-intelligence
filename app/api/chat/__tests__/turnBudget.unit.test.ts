// Brief 43 PR 4 (Q4; M23): the chat turn's time budget, run through the real
// route on stand-ins (harness.pr4.ts: in-memory Prisma, scripted Anthropic and
// OpenAI replies; nothing is sent anywhere). Time is a fake clock, so no test
// waits 40 seconds. [engineering precaution: Vercel stops the function at 60 s]
import { tables, ai, HANG, flush, resetTables, dbDelayMs } from './harness.pr4'
import { test, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { anthropicTool, anthropicText } from '../../../../lib/__tests__/fakeAiFetch'
import { CANNED_GENERIC } from '../../../../lib/chat/guards/retry'

const START = Date.parse('2026-10-19T15:00:00Z')
const TIMED_OUT = "I couldn't finish that; try a narrower question."
const reply = (response: string) => anthropicTool('drift_response', { response, suggestions: [], referencedDeals: [] })
// Brief 43 PR 9 (Q15): a report needs a buyer id that search_parties returned
// earlier in the turn, so the report tests search for the buyer first.
const BUSHWICK_BUYER = {
  id: 'buyer-1', organizationId: 'org-test', category: 'BUYER_ISO', isDuplicate: false, processingStatus: 'active',
  extractedTitle: 'Bushwick 3-family buyer', neighborhood: 'Bushwick', neighborhoods: ['Bushwick'], isTestData: true,
}
const searchBuyer = () => anthropicTool('search_parties', { query: 'Bushwick 3-family' })

async function post(body: Record<string, unknown>) {
  const { POST } = await import('../route')
  return POST(new NextRequest('http://localhost/api/chat', { method: 'POST', body: JSON.stringify(body) }))
}

// Runs a turn whose first model call never answers. Advances the fake clock to
// 52 s (the ceiling); if the turn still hasn't ended, it plays Vercel's 60-second stop (and
// lets the old code's retries run out) so the test fails instead of hanging.
async function hungTurn(body: Record<string, unknown>, first: () => unknown = () => HANG) {
  ai.script(first)
  const arrived = ai.arrival()
  let settled = false
  const res = post(body).finally(() => { settled = true })
  await arrived
  mock.timers.tick(52_000)
  await flush()
  const endedByItself = settled
  for (let i = 0; i < 20 && !settled; i++) {
    ai.killPending()
    mock.timers.tick(10_000)
    await flush()
  }
  return { endedByItself, res: await res }
}

beforeEach(async () => {
  await import('../route') // load the route (and its SDKs) before the clock is faked
  resetTables()
  ai.reset()
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START })
})
afterEach(() => mock.timers.reset())

test('a model call that never answers: the turn ends by itself before 60 s and leaves no chat behind', async () => {
  const { endedByItself, res } = await hungTurn({ message: 'any coming soon in bedstuy?' })
  assert.ok(endedByItself, 'the turn ended without Vercel stopping it')
  assert.ok(Date.now() - START <= 52_000)
  assert.equal(res.status, 200)
  const json = await res.json() as { response: string; sessionId: string | null }
  assert.equal(json.response, TIMED_OUT)
  assert.equal(json.sessionId, null)
  assert.equal((tables.chatSession ?? []).length, 0, 'no empty chat in History')
  assert.equal((tables.chatMessage ?? []).length, 0)
  // One guard-log row with a timeout verdict, counts only (no message text).
  const rows = tables.guardFireEvent ?? []
  assert.equal(rows.length, 1)
  assert.equal(rows[0].verifierVerdict, 'timeout')
  assert.equal(rows[0].userTurn, '')
  assert.equal(rows[0].assistantAttempt, '')
  assert.equal(rows[0].finalResponseSent, TIMED_OUT)
  // The spend row is still written, so a daily cap can count the turn.
  assert.equal((tables.driftInteraction ?? []).length, 1)
})

test('an API that asks Drift to wait past the deadline: the turn still ends by 52 s', async () => {
  // The SDK honours a retry-after under 60 s and its wait ignores the abort signal.
  const busy = () => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'busy' } }),
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '59' } })
  const { endedByItself, res } = await hungTurn({ message: 'any coming soon in bedstuy?' }, busy)
  assert.ok(endedByItself, 'the turn ended without Vercel stopping it')
  assert.ok(Date.now() - START <= 52_000)
  assert.equal((await res.json() as { response: string }).response, TIMED_OUT)
  assert.equal((tables.chatSession ?? []).length, 0)
})

test('a timed-out turn in an existing chat keeps the chat as it was', async () => {
  tables.chatSession = [{ id: 'chat-1', organizationId: 'org-test', title: 'Bed-Stuy Coming Soon', archived: false }]
  tables.chatMessage = [
    { id: 'm1', sessionId: 'chat-1', organizationId: 'org-test', role: 'user', content: 'hey drift', createdAt: new Date(START - 60_000) },
    { id: 'm2', sessionId: 'chat-1', organizationId: 'org-test', role: 'assistant', content: 'Good afternoon, Ryan.', createdAt: new Date(START - 59_000) },
  ]
  const { endedByItself, res } = await hungTurn({ message: 'any coming soon in bedstuy?', sessionId: 'chat-1' })
  assert.ok(endedByItself)
  const json = await res.json() as { response: string; sessionId: string | null }
  assert.equal(json.response, TIMED_OUT)
  assert.equal(json.sessionId, 'chat-1')
  assert.equal(tables.chatSession.length, 1)
  assert.equal(tables.chatMessage.length, 2, 'nothing added to the chat')
  assert.equal((tables.guardFireEvent ?? [])[0]?.sessionId, 'chat-1')
})

test('past 40 s Drift stops searching and writes its final reply', async () => {
  ai.script(
    () => { mock.timers.tick(41_000); return anthropicTool('search_listings', { neighborhoods: ['Bedford-Stuyvesant'], category: ['COMING_SOON_SALE'] }) },
    () => reply('Two coming-soon sales in Bed-Stuy.'),
  )
  const res = await post({ message: 'any coming soon in bedstuy?' })
  assert.equal(res.status, 200)
  const json = await res.json() as { response: string; sessionId: string | null }
  const calls = ai.anthropic()
  assert.deepEqual(calls[1].body.tool_choice, { type: 'tool', name: 'drift_response' }, 'the second call is the forced final reply')
  assert.equal((calls[1].body.tools as unknown[]).length, 1)
  assert.equal(json.response, 'Two coming-soon sales in Bed-Stuy.')
  // A finished turn is saved as before: one chat, both messages.
  assert.equal(tables.chatSession.length, 1)
  assert.equal(json.sessionId, tables.chatSession[0].id)
  assert.equal(tables.chatMessage.length, 2)
})

test('past 50 s the fact-check is skipped and a clean reply goes out as written', async () => {
  ai.script(() => { mock.timers.tick(51_000); return reply('Two coming-soon sales in Bed-Stuy.') })
  const res = await post({ message: 'any coming soon in bedstuy?' })
  const json = await res.json() as { response: string }
  assert.equal(json.response, 'Two coming-soon sales in Bed-Stuy.')
  assert.equal(ai.anthropic().length, 1, 'no fact-check call')
  assert.equal(ai.openai().length, 0, 'no chat-title call either')
  assert.equal(tables.chatMessage.length, 2)
  assert.ok(Date.now() - START < 52_000)
})

test('past 50 s a reply the regex check flags gets the stock reply, with no retry', async () => {
  ai.script(() => { mock.timers.tick(51_000); return reply('See https://example.com/listing for the details.') })
  const res = await post({ message: 'any coming soon in bedstuy?' })
  const json = await res.json() as { response: string }
  assert.equal(json.response, CANNED_GENERIC)
  assert.equal(ai.anthropic().length, 1, 'no fact-check and no rewrite')
})

test('a chat title that never comes holds a finished reply up by 6 s at most', async () => {
  ai.script(() => reply('Two coming-soon sales in Bed-Stuy.'))
  ai.scriptOpenAi(() => HANG)
  let settled = false
  const pending = post({ message: 'any coming soon in bedstuy?' }).finally(() => { settled = true })
  for (let i = 0; i < 20 && ai.openai().length === 0; i++) await flush()
  assert.equal(ai.openai().length, 1, 'the title call went out')
  mock.timers.tick(6_000)
  await flush()
  assert.ok(settled, 'the reply went out without waiting for the title')
  const json = await (await pending).json() as { response: string }
  assert.equal(json.response, 'Two coming-soon sales in Bed-Stuy.')
  assert.equal(tables.chatMessage.length, 2)
  assert.equal(tables.chatSession[0].title, null, 'History titles it later')
})

test('a normal fast turn still runs the fact-check', async () => {
  ai.script(() => reply('Two coming-soon sales in Bed-Stuy.'))
  const res = await post({ message: 'any coming soon in bedstuy?' })
  const json = await res.json() as { response: string }
  assert.equal(json.response, 'Two coming-soon sales in Bed-Stuy.')
  assert.equal(ai.anthropic().length, 2, 'the reply and its fact-check')
  assert.equal(tables.chatSession.length, 1)
  assert.equal(tables.chatMessage.length, 2)
})

test('a turn that saved a report before time ran out keeps its chat, so the report stays reachable', async () => {
  // A stand-in report generator (no database reads, no model call).
  const { GENERATOR_REGISTRY } = await import('../../../../lib/reports/generators')
  const real = GENERATOR_REGISTRY['buyer-match']
  GENERATOR_REGISTRY['buyer-match'] = {
    full: async () => ({ sections: [], markdown: '# Buyer Match', sources: [], subject: 'Test buyer', matchCount: 0 }),
    section: real.section,
  }
  try {
    tables.extractedOpportunity = [BUSHWICK_BUYER]
    ai.script(
      searchBuyer,
      () => anthropicTool('generate_report', { templateId: 'buyer-match', params: { buyerId: 'buyer-1' } }),
      () => HANG,
    )
    const arrived = ai.arrival()
    let settled = false
    const pending = post({ message: 'buyer match report for the bushwick 3-family buyer' }).finally(() => { settled = true })
    await arrived // the first call (search_parties, then generate_report)
    await flush()
    mock.timers.tick(52_000)
    await flush()
    assert.ok(settled, 'the turn ended by itself')
    const json = await (await pending).json() as { response: string; sessionId: string | null; attachedReport: { reportId: string } | null }
    assert.equal(json.response, TIMED_OUT)
    assert.equal(tables.chatSession.length, 1, 'the report chat exists')
    assert.equal(json.sessionId, tables.chatSession[0].id)
    assert.equal(tables.report.length, 1)
    assert.equal(tables.report[0].sessionId, json.sessionId)
    assert.equal(json.attachedReport?.reportId, tables.report[0].id)
    assert.equal(tables.chatMessage.length, 2, 'the exchange is saved, so the chat is not empty')
    assert.deepEqual(tables.chatMessage.map(m => m.role), ['user', 'assistant'])
  } finally {
    GENERATOR_REGISTRY['buyer-match'] = real
  }
})

// Reviewer (Brief 43 PR 4 r1): the tool round is on the clock too. The real
// buyer-match generator makes one Sonnet call (recommended-adjustment) on the
// route's client with no signal; this stand-in does the same.
async function withSlowReport(fn: () => Promise<void>) {
  const { GENERATOR_REGISTRY } = await import('../../../../lib/reports/generators')
  const real = GENERATOR_REGISTRY['buyer-match']
  GENERATOR_REGISTRY['buyer-match'] = {
    full: async (p: { anthropic?: { messages: { create: (body: unknown) => Promise<unknown> } } }) => {
      try { await p.anthropic?.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 300, messages: [{ role: 'user', content: 'summary' }] }) } catch { /* the section catches */ }
      return { sections: [], markdown: '# Buyer Match', sources: [], subject: 'Test buyer', matchCount: 0 }
    },
    section: real.section,
  } as typeof real
  try { await fn() } finally { GENERATOR_REGISTRY['buyer-match'] = real }
}

test('a report still being made at the ceiling: the turn ends by 52 s and nothing is saved after the reply', async () => {
  await withSlowReport(async () => {
    tables.extractedOpportunity = [BUSHWICK_BUYER]
    ai.script(
      searchBuyer,
      () => { mock.timers.tick(45_000); return anthropicTool('generate_report', { templateId: 'buyer-match', params: { buyerId: 'buyer-1' } }) },
      () => HANG, // the report's own model call (it has no signal)
    )
    const search = ai.arrival()
    let settled = false
    const pending = post({ message: 'buyer match report for the bushwick 3-family buyer' }).finally(() => { settled = true })
    await search
    const first = ai.arrival()
    await first
    const reportCall = ai.arrival()
    await flush()
    await reportCall
    mock.timers.tick(7_000) // to 52 s, the ceiling
    await flush()
    assert.ok(settled, 'the turn ended by itself (Vercel would have stopped it at 60 s)')
    const json = await (await pending).json() as { response: string; sessionId: string | null }
    assert.equal(json.response, TIMED_OUT)
    assert.equal(json.sessionId, null)
    // The report's call fails later (as when the function is stopped): still nothing saved.
    ai.killPending()
    await flush()
    assert.equal((tables.report ?? []).length, 0, 'no report saved after the reply')
    assert.equal((tables.chatSession ?? []).length, 0, 'no empty chat in History')
  })
})

// Reviewer (Brief 43 PR 4 r2): the title cap also stops the request, so the SDK
// doesn't keep it going (and retry it after its own 10-minute timeout) once the
// reply has gone.
test('a capped chat title is stopped, not left running after the reply', async () => {
  ai.script(() => reply('Two coming-soon sales in Bed-Stuy.'))
  ai.scriptOpenAi(() => HANG)
  const pending = post({ message: 'any coming soon in bedstuy?' })
  for (let i = 0; i < 20 && ai.openai().length === 0; i++) await flush()
  mock.timers.tick(6_000)
  await flush()
  await (await pending).json()
  for (let i = 0; i < 70; i++) { mock.timers.tick(10_000); await flush(5) } // 700 s more
  assert.equal(ai.openai().length, 1, 'no second title request after the reply')
})

// Reviewer (Brief 43 PR 4 r2): a report save already under way at the ceiling
// (a slow database) lands before the reply, and the chat and reply carry it.
test('a report save under way at the ceiling: the chat keeps the exchange and the report, nothing written after the reply', async () => {
  await withSlowReport(async () => {
    dbDelayMs['chatSession.create'] = 300
    dbDelayMs['report.create'] = 300
    tables.extractedOpportunity = [BUSHWICK_BUYER]
    ai.script(
      searchBuyer,
      () => { mock.timers.tick(30_000); return anthropicTool('generate_report', { templateId: 'buyer-match', params: { buyerId: 'buyer-1' } }) },
      () => { mock.timers.tick(21_800); return anthropicText('Widen the price a little.') }, // the report's call ends at 51.8 s
    )
    let settled = false
    const pending = post({ message: 'buyer match report for the bushwick 3-family buyer' }).finally(() => { settled = true })
    for (let i = 0; i < 60 && !settled; i++) { await flush(); mock.timers.tick(100) }
    assert.ok(settled, 'the turn ended by itself')
    assert.ok(Date.now() - START <= 54_500)
    const json = await (await pending).json() as { response: string; sessionId: string | null; attachedReport: { reportId: string } | null }
    const rowsAtReply = JSON.stringify(tables)
    for (let i = 0; i < 30; i++) { mock.timers.tick(1_000); await flush(5) }
    assert.equal(JSON.stringify(tables), rowsAtReply, 'nothing written after the reply')
    assert.equal(json.response, TIMED_OUT)
    assert.equal(tables.chatSession.length, 1)
    assert.equal(json.sessionId, tables.chatSession[0].id)
    assert.equal(tables.report.length, 1)
    assert.equal(tables.report[0].sessionId, json.sessionId)
    assert.deepEqual(tables.chatMessage.map(m => m.role), ['user', 'assistant'])
    assert.equal((tables.chatMessage[1].attachedReport as { reportId?: string } | undefined)?.reportId, tables.report[0].id, 'the reply in the chat carries the report')
    assert.equal(json.attachedReport?.reportId, tables.report[0].id)
  })
})

// Brief 43 PR 4 (review r2, S11): PR 3's draft-privacy rewrite is on the clock
// too. A draft naming an address Ryan typed needs a rewrite (lib/chat/guards/draftPrivacy.ts).
const leakyDraft = { channel: 'text', audience: 'buyer_side', body: 'Hi, the 3-family at 88 Example Ave may suit your buyer. Ryan Martin' }
const replyWithDraft = (response: string) =>
  anthropicTool('drift_response', { response, suggestions: [], referencedDeals: [], draft: leakyDraft })

test('a draft rewrite that starts near the ceiling is cut off at 52 s; the clean-up stands', async () => {
  ai.script(
    () => { mock.timers.tick(49_000); return replyWithDraft('Here is a text for the buyer agent.') },
    () => anthropicText(JSON.stringify({ isGrounded: true, flags: [] })), // the fact-check, at 49 s
    () => HANG, // the draft rewrite
  )
  let settled = false
  const pending = post({ message: 'text the buyer agent about 88 Example Ave' }).finally(() => { settled = true })
  for (let i = 0; i < 20 && ai.anthropic().length < 3; i++) await flush()
  assert.equal(ai.anthropic().length, 3, 'the rewrite went out (before 50 s)')
  mock.timers.tick(3_000) // to 52 s, the ceiling
  await flush()
  assert.ok(settled, 'the reply went out at the ceiling')
  assert.ok(Date.now() - START <= 52_000)
  const json = await (await pending).json() as { response: string; draft: { body: string } | null }
  assert.doesNotMatch(JSON.stringify(json.draft), /88 Example Ave/)
  assert.equal(tables.chatMessage.length, 2)
})

test('past 50 s a flagged draft gets no rewrite, only the clean-up', async () => {
  ai.script(() => { mock.timers.tick(51_000); return replyWithDraft('Here is a text for the buyer agent.') })
  const res = await post({ message: 'text the buyer agent about 88 Example Ave' })
  const json = await res.json() as { response: string; draft: { body: string } | null }
  assert.equal(ai.anthropic().length, 1, 'no fact-check and no draft rewrite')
  assert.doesNotMatch(JSON.stringify(json.draft), /88 Example Ave/)
  assert.ok(Date.now() - START < 52_000)
})

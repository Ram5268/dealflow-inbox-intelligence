import { db, script, driftCalls, reset, postChat, getChat } from './pr3ChatHarness'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicTool, systemPromptOf } from '../../../../lib/__tests__/fakeAiFetch'

// Brief 43 PR 14, through the real chat route with fake Prisma and scripted AI
// replies (no database, no network):
// - D7 [Brief 42 default]: Drift is no longer asked for hidden follow-up
//   suggestions, and none are returned or stored; old rows that have them still
//   load;
// - D8 [Brief 42 default] and Q33: no calendar proposal field while Outlook is
//   paused [Ryan, 2026-09-24]; the per-turn note says so, with today's date and
//   the email-paused line (Q29);
// - F9 (dormant): the paused reply comes before any date maths;
// - Q38: no em-dash or "!" reaches the page, the database or the voice reply.

type Tool = { name: string; input_schema: { properties: Record<string, unknown>; required?: string[] } }
const driftTool = (i = 0) => ((driftCalls[i].body.tools as Tool[]).find(t => t.name === 'drift_response'))!
const reply = (response: string, extra: Record<string, unknown> = {}) => anthropicTool('drift_response', { response, referencedDeals: [], ...extra })
const assistantRows = () => db.messages.filter(m => m.role === 'assistant')

test('D7: the reply tool has no suggestions; none come back or are stored', async () => {
  reset()
  script.push(reply('Good morning, Ryan. What are we looking at today?'))
  const { status, json } = await postChat({ message: 'hey drift' })
  assert.equal(status, 200)
  const tool = driftTool()
  assert.ok(!('suggestions' in tool.input_schema.properties), 'no suggestions field')
  assert.ok(!(tool.input_schema.required ?? []).includes('suggestions'))
  assert.deepEqual(tool.input_schema.required, ['response', 'referencedDeals'])
  assert.ok(!('suggestions' in json), 'no suggestions in the reply JSON')
  assert.equal(json.response, 'Good morning, Ryan. What are we looking at today?')
  const row = assistantRows()[0]
  assert.equal(row.suggestions, undefined, 'nothing written to the suggestions column')
  assert.equal(row.content, 'Good morning, Ryan. What are we looking at today?')
})

test('D7: a reply with a draft is stored without suggestions', async () => {
  reset()
  const draft = { channel: 'email', audience: 'buyer_side', subject: 'A 3-family in Bed-Stuy', body: 'Hi,\n\nI have a 3-family in Bed-Stuy that may suit your buyer. Price on request.\n\nBest,\nRyan Martin' }
  script.push(reply("Here's a draft for you to copy.", { draft }))
  await postChat({ message: 'draft a note to the buyer agent about a 3-family in Bed-Stuy' })
  const stored = JSON.parse(String(assistantRows()[0].content)) as Record<string, unknown>
  assert.deepEqual(Object.keys(stored).sort(), ['draft', 'response'])
})

test('D8: while Outlook is paused there is no calendar proposal field, and the note says so', async () => {
  reset()
  delete process.env.GRAPH_ENABLED
  script.push(reply("Your calendar isn't connected right now, so I can't book it. I'll keep the details here: a showing at 88 Example Ave, Thursday 3 pm."))
  await postChat({ message: 'book a showing at 88 Example Ave thursday at 3pm' })
  assert.ok(!('pendingEvent' in driftTool().input_schema.properties))
  const system = systemPromptOf(driftCalls[0])
  assert.match(system, /TODAY: \w+day, \w+ \d+, \d{4}/)
  assert.ok(system.includes("Your calendar isn't connected right now, so I can't book it. I'll keep the details here:"))
  assert.match(system, /EMAIL: Email reading is paused/)
  assert.ok(!system.includes('pendingEvent'))
})

test('Outlook on (dormant): the proposal field and its note come back', async () => {
  reset()
  process.env.GRAPH_ENABLED = 'true'
  try {
    script.push(reply('Here is what I found.'))
    await postChat({ message: 'any coming soon in bedstuy?' })
    assert.ok('pendingEvent' in driftTool().input_schema.properties)
    const system = systemPromptOf(driftCalls[0])
    assert.match(system, /pendingEvent/)
    assert.doesNotMatch(system, /Email reading is paused/)
  } finally {
    delete process.env.GRAPH_ENABLED
  }
})

test('Q38: em-dashes and "!" never reach the page or the database', async () => {
  reset()
  script.push(reply('Two coming-soon sales in Bed-Stuy — the stronger is a 3-family at $1,850,000! Want buyers who could take it?'))
  const { json } = await postChat({ message: 'any coming soon in bedstuy?' })
  const want = 'Two coming-soon sales in Bed-Stuy, the stronger is a 3-family at $1,850,000. Want buyers who could take it?'
  assert.equal(json.response, want)
  assert.equal(assistantRows()[0].content, want)
})

test('old rows with suggestions (and an old proposal) still load and read as text', async () => {
  reset()
  db.sessions.push({ id: 'sess_pr3', title: null }) // Brief 43 PR 4: the chat's row exists
  db.messages.push(
    { id: 'old_1', sessionId: 'sess_pr3', role: 'user', content: 'book a showing friday', createdAt: new Date('2026-09-01T12:00:00Z') },
    {
      id: 'old_2', sessionId: 'sess_pr3', role: 'assistant', createdAt: new Date('2026-09-01T12:00:05Z'),
      content: JSON.stringify({ response: 'Shall I add it?', suggestions: ['Add it', 'Pick another time'], pendingEvent: { subject: 'Showing', startISO: 'next thursday' } }),
      suggestions: ['Add it', 'Pick another time'],
    },
  )
  const { messages } = await getChat('sess_pr3')
  assert.equal(messages.length, 2)
  assert.equal(messages[1].content, 'Shall I add it?')
  assert.equal(messages[1].draft, null)

  // A new turn in that chat: the old reply goes to the model as its text.
  script.push(reply('Here is what I found.'))
  await postChat({ message: 'thanks, any coming soon in bedstuy?', sessionId: 'sess_pr3' })
  const history = driftCalls[0].body.messages as Array<{ role: string; content: unknown }>
  assert.ok(history.some(m => m.role === 'assistant' && m.content === 'Shall I add it?'), JSON.stringify(history))
})

test('F9: a "yes" to an old proposal with an unreadable time gets the paused reply, not an error', async () => {
  reset()
  db.sessions.push({ id: 'sess_pr3', title: null }) // Brief 43 PR 4: the chat's row exists
  delete process.env.GRAPH_ENABLED
  db.messages.push(
    { id: 'old_1', sessionId: 'sess_pr3', role: 'user', content: 'book a showing friday', createdAt: new Date('2026-09-01T12:00:00Z') },
    { id: 'old_2', sessionId: 'sess_pr3', role: 'assistant', createdAt: new Date('2026-09-01T12:00:05Z'), content: JSON.stringify({ response: 'Shall I add it?', suggestions: [], pendingEvent: { subject: 'Showing', startISO: 'next thursday' } }) },
  )
  const { status, json } = await postChat({ message: 'yes', sessionId: 'sess_pr3' })
  assert.equal(status, 200)
  assert.match(String(json.response), /Outlook is paused/)
  assert.equal(driftCalls.length, 0, 'no AI call on the confirm path')
})

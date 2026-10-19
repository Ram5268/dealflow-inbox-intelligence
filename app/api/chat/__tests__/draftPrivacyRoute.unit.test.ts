import { db, script, driftCalls, reset, postChat, getChat } from './pr3ChatHarness'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicTool } from '../../../../lib/__tests__/fakeAiFetch'

// Brief 43 PR 3 (Q3, spot #17): a draft that names a homeowner is cleaned before
// it reaches the page or the database. The real chat route, with fake Prisma and
// scripted AI replies; no database, no network. Everyone here is fictional.

const PAT_ROW = { id: 'mojo_pr3', fullName: 'Pat Example', phone: '7185550142', neighborhood: 'Bedford-Stuyvesant', city: 'Brooklyn', address: '88 Example Ave' }
const LEAKY = {
  channel: 'email', audience: 'buyer_side', subject: 'The home at 88 Example Ave',
  body: 'Hi,\n\nI have an off-market 3-family in Bed-Stuy, within the $2.1M to $3.3M range, that may suit your buyer. The owner, Pat Example, can be reached at (718) 555-0142. The home is at 88 Example Ave. It is going through probate.\n\nBest,\nRyan',
}
const CLEAN = { channel: 'email', audience: 'buyer_side', subject: 'A 3-family in Bed-Stuy', body: 'Hi,\n\nI have an off-market 3-family in Bed-Stuy that may suit your buyer. Price on request.\n\nBest,\nRyan' }
const LINE = "Here's a draft for you to copy."
const reply = (draft?: unknown) => anthropicTool('drift_response', { response: LINE, suggestions: ['a', 'b'], referencedDeals: [], ...(draft ? { draft } : {}) })
const LEAKS = ['Pat', '555', '0142', '88 Example', '$', 'probate']
const assistantRow = () => db.messages.find(m => m.role === 'assistant') as { content: string }

test('a flagged draft gets one rewrite; when that still leaks, the clean-up reaches the JSON and the database', async () => {
  reset()
  db.mojoContacts = [PAT_ROW]
  script.push(anthropicTool('search_parties', { role: 'seller' }), reply(LEAKY), reply(LEAKY))
  const { status, json } = await postChat({ message: 'draft a note to the buyer about the home at 88 Example Ave' })
  assert.equal(status, 200)
  assert.deepEqual(json.draft, {
    channel: 'email', audience: 'buyer_side', subject: 'A home that may suit your buyer',
    body: 'Hi,\n\nI have an off-market 3-family in Bed-Stuy, price on request, that may suit your buyer.\n\nBest,\nRyan Martin',
  })
  assert.equal(json.response, LINE)
  for (const s of LEAKS) assert.ok(!JSON.stringify(json.draft).includes(s), s)

  // The rewrite: one forced drift_response with the feedback.
  assert.equal(driftCalls.length, 3)
  const redo = driftCalls[2].body as { tool_choice: unknown; messages: Array<{ role: string; content: unknown }> }
  assert.deepEqual(redo.tool_choice, { type: 'tool', name: 'drift_response' })
  assert.match(String(redo.messages[redo.messages.length - 1].content), /Your draft can't go to anyone as written/)

  // Stored with the reply (inside the content JSON), only the cleaned version.
  const stored = assistantRow().content
  assert.deepEqual(JSON.parse(stored).draft, json.draft)
  for (const s of LEAKS) assert.ok(!stored.includes(s), s)

  // Counts-only telemetry: what was flagged, never the flagged text.
  const tele = (db.interactions[0].parsedFilters as { draftPrivacy: { outcome: string; flagKinds: string[]; rewrote: boolean } }).draftPrivacy
  assert.equal(tele.outcome, 'cleaned')
  assert.equal(tele.rewrote, true)
  assert.ok(tele.flagKinds.includes('homeowner_name') && tele.flagKinds.includes('street_address'))
  assert.ok(!JSON.stringify(tele).includes('Pat'))

  // A reopened chat shows the reply and its draft.
  const { messages } = await getChat('sess_pr3')
  const shown = messages.find(m => m.role === 'assistant')!
  assert.equal(shown.content, LINE)
  assert.deepEqual(shown.draft, json.draft)
})

test('a clean rewrite is used as it is, signed "Ryan Martin"', async () => {
  reset()
  db.mojoContacts = [PAT_ROW]
  script.push(anthropicTool('search_parties', { role: 'seller' }), reply(LEAKY), reply(CLEAN))
  const { json } = await postChat({ message: 'draft a note to the buyer about the home at 88 Example Ave' })
  assert.deepEqual(json.draft, { ...CLEAN, body: CLEAN.body.replace(/Ryan$/, 'Ryan Martin') })
})

test('an address Ryan typed is kept out of a draft even with no CRM lookup this turn', async () => {
  reset()
  const typed = { channel: 'text', audience: 'buyer_side', body: 'Hi, the 3-family at 88 Example Ave may suit your buyer. Ryan Martin' }
  script.push(reply(typed), reply(typed))
  const { json } = await postChat({ message: 'text the buyer agent about 88 Example Ave' })
  assert.equal(json.draft, null)
  assert.match(String(json.response), /couldn't write that draft/)
  assert.equal(driftCalls.length, 2)
})

test('a reply with no draft is unchanged and stored as plain text', async () => {
  reset()
  script.push(reply())
  const { json } = await postChat({ message: 'anything new in Bed-Stuy?' })
  assert.equal(json.draft, null)
  assert.equal(json.response, LINE)
  assert.equal(assistantRow().content, LINE)
  assert.equal(driftCalls.length, 1)
})

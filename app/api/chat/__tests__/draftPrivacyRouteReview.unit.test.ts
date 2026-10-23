import { db, script, driftCalls, verifierCalls, setVerifier, reset, postChat } from './pr3ChatHarness'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicTool } from '../../../../lib/__tests__/fakeAiFetch'

// Brief 43 PR 3, review r1: the route paths the first version missed. Fake Prisma,
// scripted AI replies; no database, no network. Everyone here is fictional.

const PAT_ROW = { id: 'mojo_pr3', fullName: 'Pat Example', phone: '7185550142', neighborhood: 'Bedford-Stuyvesant', city: 'Brooklyn', address: '88 Example Ave' }
const reply = (response: string, draft?: unknown) => anthropicTool('drift_response', { response, suggestions: ['a', 'b'], referencedDeals: [], ...(draft ? { draft } : {}) })
const LEAKS = ['Pat', '555', '0142', '88 Example', '$', 'probate']
const LINE = "Here's a draft for you to copy."

test('the fact-check sees the draft, and a guard rewrite corrects it', async () => {
  reset()
  let n = 0
  setVerifier(() => (n++ === 0 ? { isGrounded: false, flags: [{ claim: 'on a brownstone corridor', reason: 'not in the tool results' }] } : { isGrounded: true, flags: [] }))
  const d1 = { channel: 'email', audience: 'buyer_side', body: 'Hi Jordan,\n\nA 3-family in Bed-Stuy on a brownstone corridor may suit your buyer. Price on request.\n\nBest,\nRyan Martin' }
  const d2 = { channel: 'email', audience: 'buyer_side', body: 'Hi Jordan,\n\nA 3-family in Bed-Stuy may suit your buyer. Price on request.\n\nBest,\nRyan Martin' }
  script.push(reply(LINE, d1), reply(LINE, d2))
  const { json } = await postChat({ message: 'draft a note to my buyer about a 3-family in Bed-Stuy' })
  assert.ok(JSON.stringify(verifierCalls[0].body).includes('on a brownstone corridor'))
  const retry = driftCalls[1].body as { messages: Array<{ role: string; content: unknown }> }
  assert.match(String(retry.messages[retry.messages.length - 2].content), /brownstone corridor/)
  assert.deepEqual(json.draft, d2)
})

test("the model's history shows an earlier draft as text, not JSON", async () => {
  reset()
  const d = { channel: 'text', audience: 'homeowner', body: 'Hi, this is Ryan Martin. Would you ever consider selling?' }
  script.push(reply(LINE, d))
  await postChat({ message: 'text the owner and ask if they would sell' })
  script.push(reply('ok'))
  await postChat({ message: 'thanks', sessionId: 'sess_pr3' })
  const turns = (driftCalls[driftCalls.length - 1].body as { messages: Array<{ role: string; content: unknown }> }).messages
  const earlier = String(turns.find(m => m.role === 'assistant')?.content)
  assert.equal(earlier, `${LINE}\n\nDraft (text, homeowner):\nHi, this is Ryan Martin. Would you ever consider selling?`)
})

test('a draft written into the reply is checked like one in the draft field', async () => {
  reset()
  db.mojoContacts = [PAT_ROW]
  const inline = "Here's the draft:\n\nHi Jordan,\n\nPat Example at (718) 555-0142 may sell the 3-family at 88 Example Ave in Bed-Stuy, around $2.1M. It is going through probate.\n\nBest,\nRyan"
  script.push(anthropicTool('find_seller', { name: 'Pat Example' }), reply(inline), reply(inline))
  const { json } = await postChat({ message: "draft a note to my buyer Jordan about Pat Example's house" })
  for (const s of LEAKS) {
    assert.ok(!String(json.response).includes(s), `reply: ${s}`)
    assert.ok(!JSON.stringify(json.draft ?? '').includes(s), `draft: ${s}`)
  }
  const stored = String((db.messages.find(m => m.role === 'assistant') as { content: string }).content)
  for (const s of LEAKS) assert.ok(!stored.includes(s), `stored: ${s}`)
})

test('a note about a listing shown earlier in the chat passes untouched, with no rewrite', async () => {
  reset()
  db.messages.push(
    { id: 'm1', sessionId: 'sess_pr3', role: 'user', content: 'tell me about 12 Sample St', createdAt: new Date(Date.UTC(2026, 9, 19, 11)) },
    { id: 'm2', sessionId: 'sess_pr3', role: 'assistant', content: '12 Sample St is a 3-bed asking $1.25M.', dealsJson: [{ id: 'opp1', category: 'ACTIVE_SALE_LISTING', address: '12 Sample St', price: 1_250_000 }], createdAt: new Date(Date.UTC(2026, 9, 19, 11, 1)) },
  )
  const d = { channel: 'email', audience: 'buyer_side', subject: 'The 3-bed at 12 Sample St', body: 'Hi Jordan,\n\nThe 3-bed at 12 Sample St is asking $1,250,000. Want to see it this week?\n\nBest,\nRyan Martin' }
  script.push(reply(LINE, d))
  const { json } = await postChat({ message: 'draft an email to my buyer Jordan about it', sessionId: 'sess_pr3' })
  assert.deepEqual(json.draft, d)
  assert.equal(driftCalls.length, 1)
})

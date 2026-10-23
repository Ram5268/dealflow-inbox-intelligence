import { current, fakePrisma, ORG } from '../../../../../lib/__tests__/pr17FakePrisma' // first: no database client
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installFakeAiFetch } from '../../../../../lib/__tests__/fakeAiFetch'
import { encodeStoredReply } from '../../../../../lib/chat/storedReply'
import { shouldRetitle } from '../../../../../lib/chat/retitleOnce'

// Brief 43 PR 16 (Q36; U-08): each chat is titled once. Opening History used to
// call the retitle route on every open while any chat was untitled; a chat whose
// title call failed (or that the route can't title) kept the trigger on. The
// route also read Drift's stored reply as raw JSON. PR 17's limits (visible,
// unarchived, last day, at most 20) are covered in retitle.unit.test.ts.

const ROOT = join(__dirname, '..', '..', '..', '..', '..')
const ai = installFakeAiFetch()
let aiTitle = 'Brooklyn Buyer Search'
ai.reply(() => ({
  id: 'chatcmpl-test', object: 'chat.completion', created: 0, model: 'gpt-4o-mini',
  choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: aiTitle, refusal: null } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}))

beforeEach(() => {
  current.fake = fakePrisma()
  ai.requests.length = 0
  aiTitle = 'Brooklyn Buyer Search'
})

function chat(id: string, o: { archived?: boolean; reply?: string } = {}) {
  const at = new Date(Date.now() - 3_600_000)
  current.fake.data.chatSession.push({ id, organizationId: ORG, title: null, archived: o.archived ?? false, createdAt: at, updatedAt: at })
  current.fake.data.chatMessage.push({ id: `${id}_u`, sessionId: id, role: 'user', content: 'Any two-family homes near 88 Example Ave?', createdAt: at })
  current.fake.data.chatMessage.push({ id: `${id}_a`, sessionId: id, role: 'assistant', content: o.reply ?? 'Two fit.', createdAt: at })
}

async function retitle() {
  const { POST } = await import('../route')
  return (await POST()).json()
}
const titleOf = (id: string) => current.fake.data.chatSession.find(s => s.id === id)?.title

test('a chat is titled once: a failed title call leaves a plain stand-in, so it is not tried again', async () => {
  chat('c1')
  aiTitle = '' // the title call gave nothing back
  await retitle()
  assert.equal(ai.requests.length, 1)
  assert.equal(titleOf('c1'), 'Any two-family homes near 88 Example Ave?')
  await retitle()
  assert.equal(ai.requests.length, 1) // no second try on the next History open
})

test('archived chats are ignored, and a titled chat is never re-titled', async () => {
  chat('visible')
  chat('archived', { archived: true })
  await retitle()
  assert.equal(titleOf('visible'), 'Brooklyn Buyer Search')
  assert.equal(titleOf('archived'), null)
  aiTitle = 'Something Else Entirely'
  await retitle()
  assert.equal(titleOf('visible'), 'Brooklyn Buyer Search')
  assert.equal(ai.requests.length, 1)
})

test("Drift's stored reply is read as its text, never as raw JSON", async () => {
  const draft = { channel: 'email' as const, audience: 'buyer_side' as const, subject: 'A two-family', body: 'Hi Pat, one fits.' }
  chat('with_draft', { reply: encodeStoredReply({ response: 'One fits; here is a draft.', draft }) })
  await retitle()
  const sent = JSON.stringify(ai.requests[0].body)
  assert.match(sent, /Assistant replied: One fits; here is a draft\./)
  assert.doesNotMatch(sent, /\\"response\\"|suggestions/)
})

test('History asks for titles once per untitled chat per page load', () => {
  const asked = new Set<string>()
  const sessions = [{ id: 'a', title: null }, { id: 'b', title: 'Coming Soon Under 2M' }]
  assert.equal(shouldRetitle(sessions, asked), true)
  assert.equal(shouldRetitle(sessions, asked), false) // the next open: nothing new
  assert.equal(shouldRetitle([...sessions, { id: 'c', title: null }], asked), true) // a new untitled chat
  assert.equal(shouldRetitle([{ id: 'b', title: 'Coming Soon Under 2M' }], new Set()), false)
})

test('the History drawer uses shouldRetitle before calling the route', () => {
  const drawer = readFileSync(join(ROOT, 'components/HistoryDrawer.tsx'), 'utf8')
  assert.match(drawer, /!showArchived && shouldRetitle\(d\.sessions \?\? \[\], retitleAsked\)/)
  assert.doesNotMatch(drawer, /some\(\(s: Session\) => !s\.title\)/)
})

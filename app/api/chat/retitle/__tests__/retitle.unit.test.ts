import { current, fakePrisma, ORG, countFetches } from '../../../../../lib/__tests__/pr17FakePrisma' // first: no database client
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { installFakeAiFetch, openAiChat } from '../../../../../lib/__tests__/fakeAiFetch'

// Brief 43 PR 17 [engineering precaution] (DealFlow has no login [Ryan,
// 2026-09-24]): POST /api/chat/retitle (the History drawer calls it on
// every open) titles at most 20 chats per call, and only visible (unarchived)
// chats with a user message, updated in the last day. Before, it titled every
// untitled chat, archived ones included, with no cap: one gpt-4o-mini call each.

const ai = installFakeAiFetch()
const outside = countFetches()
ai.reply(() => ({ ...openAiChat('x'), choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: 'Brooklyn Buyer Search', refusal: null } }] }))

const HOUR = 3_600_000
const ago = (ms: number) => new Date(Date.now() - ms)

beforeEach(() => {
  current.fake = fakePrisma()
  ai.requests.length = 0
  outside.length = 0
})

function chat(id: string, o: { archived?: boolean; ageMs?: number; title?: string | null; userMessage?: boolean } = {}) {
  const { data } = current.fake
  const at = ago(o.ageMs ?? HOUR)
  data.chatSession.push({ id, organizationId: ORG, title: o.title ?? null, archived: o.archived ?? false, createdAt: at, updatedAt: at })
  if (o.userMessage ?? true) {
    data.chatMessage.push({ id: `${id}_u`, sessionId: id, role: 'user', content: 'Any two-family homes near 88 Example Ave?', createdAt: at })
    data.chatMessage.push({ id: `${id}_a`, sessionId: id, role: 'assistant', content: 'Two fit.', createdAt: at })
  }
}

async function retitle() {
  const { POST } = await import('../route')
  const res = await POST()
  return { status: res.status, body: await res.json() }
}

const titled = () => current.fake.data.chatSession.filter(s => s.title).map(s => s.id as string)

test('archived chats are never retitled', async () => {
  chat('visible')
  chat('archived_1', { archived: true })
  chat('archived_2', { archived: true, ageMs: 60_000 })
  const { body } = await retitle()
  assert.deepEqual(titled(), ['visible'])
  assert.equal(body.updated, 1)
  assert.equal(ai.requests.length, 1)
})

test('at most 20 chats per call, newest first; the rest wait for the next open', async () => {
  for (let i = 0; i < 25; i++) chat(`c${String(i).padStart(2, '0')}`, { ageMs: (i + 1) * 60_000 })
  const { body } = await retitle()
  assert.equal(body.updated, 20)
  assert.equal(ai.requests.length, 20)
  assert.equal(outside.length, 20)
  assert.deepEqual(titled(), Array.from({ length: 20 }, (_, i) => `c${String(i).padStart(2, '0')}`))
})

test('only chats updated in the last day, with a user message, are titled', async () => {
  chat('fresh', { ageMs: 23 * HOUR })
  chat('stale', { ageMs: 25 * HOUR })
  chat('report_chat_no_user_message', { userMessage: false })
  chat('already_titled', { title: 'Coming Soon Under 2M' })
  const { body } = await retitle()
  assert.deepEqual(titled().sort(), ['already_titled', 'fresh'])
  assert.equal(body.updated, 1)
  assert.equal(ai.requests.length, 1)
})

test('empty chats can’t crowd real ones out of the 20', async () => {
  for (let i = 0; i < 30; i++) chat(`empty_${i}`, { userMessage: false, ageMs: 60_000 })
  chat('real', { ageMs: 2 * HOUR })
  await retitle()
  assert.deepEqual(titled(), ['real'])
})

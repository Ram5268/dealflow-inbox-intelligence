// Brief 48 PR 13 (M22; TEST_PLAN E-12): switching chats while Drift was
// answering filed the late reply in the chat on screen, and pointed Ryan's
// next message back at the old chat (app/chat/page.tsx applied a reply to
// whatever was open when it arrived, then set the open chat back to the one it
// was asked in). The page now notes which chat each question was asked in
// (lib/chat/chatView.ts) and asks that note what to do with the reply. The
// reply is always saved in its own chat by the server, so leaving it off
// another chat's screen loses nothing. Pure, plus a check that the page uses
// the note; the executor runs the browser check with mocked replies.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createChatView } from '../chatView'

test('a reply in the chat it was asked in shows, and a new chat takes the id its first reply made', () => {
  const v = createChatView()
  v.open(null)
  const sent = v.token()
  assert.equal(v.replyAction(sent, 'chat_new'), 'show')
  v.adopt('chat_new')
  assert.deepEqual(v.token(), { view: sent.view, sessionId: 'chat_new' })
  assert.equal(v.isCurrent(sent), true, 'adopting an id is still the same chat')
})

test("switching to chat B mid-answer: A's reply stays off B, and the next message goes to B", () => {
  const v = createChatView()
  v.open('chat_a')
  const sent = v.token()
  v.open('chat_b')
  assert.equal(v.replyAction(sent, 'chat_a'), 'drop')
  assert.equal(v.isCurrent(sent), false)
  assert.equal(v.token().sessionId, 'chat_b')
})

test('back on chat A before its reply arrives: A is reloaded from the server, which has the reply', () => {
  const v = createChatView()
  v.open('chat_a')
  const sent = v.token()
  v.open('chat_b')
  v.open('chat_a')
  assert.equal(v.replyAction(sent, 'chat_a'), 'reload')
})

test("a new chat's first reply, after switching to another chat, stays in its own new chat", () => {
  const v = createChatView()
  v.open(null)
  const sent = v.token()
  v.open('chat_b')
  assert.equal(v.replyAction(sent, 'chat_new'), 'drop')
  v.open(null)
  assert.equal(v.replyAction(sent, 'chat_new'), 'drop', 'another new chat is another chat')
  assert.equal(v.replyAction(sent, null), 'drop')
})

// The page: every switch opens a new view, and a reply goes through replyAction
// before it touches the chat on screen or the open chat's id.
test('the chat page files replies through the chat view', () => {
  const src = readFileSync(join(__dirname, '../../../app/chat/page.tsx'), 'utf8')
  assert.match(src, /from '@\/lib\/chat\/chatView'/)
  const sendAt = src.indexOf('async function send(')
  const send = src.slice(sendAt, src.indexOf('const refetchMessages', sendAt))
  assert.ok(send.length > 0)
  const decide = send.indexOf('chatView.replyAction(')
  assert.ok(decide > 0, 'send() asks the chat view')
  assert.ok(send.indexOf('setCurrentSessionId(') > decide, 'the open chat id changes only after that')
  assert.ok(send.indexOf("role: 'assistant'") > decide, 'the reply is added only after that')
  // New chat (two ways) and opening a chat from History each open a new view.
  assert.ok((src.match(/chatView\.open\(/g) ?? []).length >= 3)
  const reportAt = src.indexOf('async function generateReport(')
  const report = src.slice(reportAt, src.indexOf('function userQuestionFor(', reportAt))
  assert.match(report, /chatView\.isCurrent\(/, 'a report finished after a switch stays in its own chat too')
})

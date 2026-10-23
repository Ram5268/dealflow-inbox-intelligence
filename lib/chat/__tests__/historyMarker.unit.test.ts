// Brief 43 PR 16 (Q43; X-07): Drift remembers the newest 30 messages of a chat.
// When older ones were left out, the model's conversation now says so, instead
// of starting mid-chat as if that were the beginning. PR 8's Shown notes stay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EARLIER_IN_CHAT, EARLIER_NOT_SHOWN, HISTORY_LIMIT, historyForModel, historyWindow, recentHistoryQuery } from '../history'
import { encodeStoredReply } from '../storedReply'

const ROOT = join(__dirname, '..', '..', '..')
type Msg = { id: string; role: 'user' | 'assistant'; content: string }
// n messages, newest first (what the query returns): user turn k and Drift's reply k.
const newestFirst = (n: number): Msg[] => Array.from({ length: n }, (_, i) => ({
  id: `m${i + 1}`, role: i % 2 === 0 ? 'user' as const : 'assistant' as const, content: `${i % 2 === 0 ? 'user' : 'drift'} turn ${Math.floor(i / 2) + 1}`,
})).reverse()

test('the query reads one row past the window, so we know when older messages were left out', () => {
  assert.equal(recentHistoryQuery('s1').take, HISTORY_LIMIT + 1)
  const long = historyWindow(newestFirst(40))
  assert.equal(long.history.length, HISTORY_LIMIT)
  assert.equal(long.earlierNotShown, true)
  assert.equal(long.history[0].content, 'user turn 6')
  assert.equal(long.history[29].content, 'drift turn 20')
  const exact = historyWindow(newestFirst(30))
  assert.equal(exact.history.length, 30)
  assert.equal(exact.earlierNotShown, false)
  assert.equal(historyWindow(newestFirst(31)).earlierNotShown, true)
  assert.deepEqual(historyWindow([]), { history: [], earlierNotShown: false })
})

test('a long chat starts with "(earlier messages not shown)"', () => {
  const { history, earlierNotShown } = historyWindow(newestFirst(40))
  const sent = historyForModel(history, { earlierNotShown })
  assert.equal(EARLIER_NOT_SHOWN, '(earlier messages not shown)')
  assert.equal(sent[0].role, 'user')
  assert.equal(sent[0].content, `${EARLIER_NOT_SHOWN}\n\nuser turn 6`)
  assert.equal(sent.length, 30)
})

test('when the window starts on a Drift message, the placeholder turn carries the marker', () => {
  const rows = [{ role: 'assistant', content: 'drift turn 5' }, { role: 'user', content: 'user turn 6' }]
  const sent = historyForModel(rows, { earlierNotShown: true })
  assert.deepEqual(sent[0], { role: 'user', content: EARLIER_NOT_SHOWN })
  assert.equal(sent.length, 3)
  // a short "+" report chat keeps PR 8's placeholder, with no marker
  assert.deepEqual(historyForModel(rows)[0], { role: 'user', content: EARLIER_IN_CHAT })
})

test('a short chat has no marker', () => {
  const { history, earlierNotShown } = historyWindow(newestFirst(6))
  const sent = historyForModel(history, { earlierNotShown })
  assert.equal(sent[0].content, 'user turn 1')
  assert.ok(sent.every(m => !m.content.includes(EARLIER_NOT_SHOWN)))
})

test("PR 8's Shown notes still ride along with the marker", () => {
  const reply = encodeStoredReply({ response: 'Here is the report.', shown: { reportId: 'rep_1', buyerId: 'buyer_1' } })
  const sent = historyForModel([{ role: 'user', content: 'run the report' }, { role: 'assistant', content: reply }], { earlierNotShown: true })
  assert.equal(sent[0].content, `${EARLIER_NOT_SHOWN}\n\nrun the report`)
  assert.match(sent[1].content, /^Here is the report\.\n\n\[Shown with this reply/)
  assert.match(sent[1].content, /rep_1/)
})

test('the chat route loads history through historyWindow and passes the marker on', () => {
  const route = readFileSync(join(ROOT, 'app/api/chat/route.ts'), 'utf8')
  assert.match(route, /const \{ history, earlierNotShown \} = historyWindow\(session \? await prisma\.chatMessage\.findMany\(recentHistoryQuery\(session\.id\)\) : \[\]\)/)
  assert.match(route, /historyForModel\(history, \{ earlierNotShown \}\)/)
})

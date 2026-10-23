// Brief 43 PR 15 (Q31): one prompt-cache breakpoint on the newest tool result
// in the tool-use loop, and never more than Anthropic's 4 in a request (the
// system blocks hold 2). Pure.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type Anthropic from '@anthropic-ai/sdk'
import { cacheLastToolResult } from '../promptCache'
import { buildSystemBlocks } from '../systemBlocks'

type Msg = Anthropic.Messages.MessageParam
const toolUse = (id: string): Msg => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'search_listings', input: {} }] })
const toolResults = (...ids: string[]): Msg => ({ role: 'user', content: ids.map(id => ({ type: 'tool_result' as const, tool_use_id: id, content: '{"cards":[]}' })) })
const marks = (v: unknown): number => {
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + marks(x), 0)
  if (v && typeof v === 'object') return Object.entries(v).reduce((n, [k, x]) => n + (k === 'cache_control' && x ? 1 : marks(x)), 0)
  return 0
}
const marked = (messages: Msg[]) => messages.flatMap(m => (typeof m.content === 'string' ? [] : m.content))
  .filter(b => b.type === 'tool_result' && b.cache_control).map(b => (b as Anthropic.Messages.ToolResultBlockParam).tool_use_id)

test('the breakpoint lands on the last tool result, and moves on each round', () => {
  const messages: Msg[] = [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier reply' }, { role: 'user', content: [{ type: 'text', text: 'find 3-families in Bed-Stuy' }] }]
  cacheLastToolResult(messages)
  assert.deepEqual(marked(messages), [], 'no tool result yet: no breakpoint')

  messages.push(toolUse('t1'), toolResults('t1'))
  cacheLastToolResult(messages)
  assert.deepEqual(marked(messages), ['t1'])

  // Two searches in one round: the second result of the newest round.
  messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'search_listings', input: {} }, { type: 'tool_use', id: 't3', name: 'search_parties', input: {} }] }, toolResults('t2', 't3'))
  cacheLastToolResult(messages)
  assert.deepEqual(marked(messages), ['t3'], 'only the newest round keeps it')
  assert.deepEqual((messages[messages.length - 1].content as Anthropic.Messages.ToolResultBlockParam[])[1].cache_control, { type: 'ephemeral' })
})

test('with the system blocks, a request has at most 4 breakpoints however many rounds run', () => {
  const system = buildSystemBlocks('SYSTEM PROMPT', 'MARKET RATE: today')
  const messages: Msg[] = [{ role: 'user', content: 'go' }]
  for (let i = 0; i < 6; i++) {
    messages.push(toolUse(`t${i}`), toolResults(`t${i}`))
    cacheLastToolResult(messages)
    assert.equal(marks({ system, messages }), 3, `round ${i + 1}`)
  }
  // A guard retry adds Drift's reply and the feedback after the results: still 3.
  const retry = [...messages, { role: 'assistant' as const, content: 'reply' }, { role: 'user' as const, content: 'feedback' }]
  assert.ok(marks({ system, messages: retry }) <= 4)
})

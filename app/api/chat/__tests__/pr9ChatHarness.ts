// Brief 43 PR 9 test helper: runs the chat route (POST /api/chat) against an
// in-memory stand-in for Prisma (lib/chat/tools/__tests__/pr9FakeDb) and
// scripted AI replies (lib/__tests__/fakeAiFetch: OpenAI and Anthropic only,
// every other address refused). No database, no network. Import this FIRST:
// lib/prisma reuses globalThis.prisma when it is set. Everyone is fictional.
import { NextRequest } from 'next/server'
import { installFakeAiFetch, openAiChat, anthropicText, systemPromptOf, type AiRequest } from '../../../../lib/__tests__/fakeAiFetch'
import { pr9FakeDb, type Row } from '../../../../lib/chat/tools/__tests__/pr9FakeDb'

export const ORG = 'org_pr9'
export const fake = pr9FakeDb()
;(globalThis as unknown as { prisma: unknown }).prisma = fake.prisma

// Drift's tool-loop calls (they carry the tools) take the scripted replies in
// order; the fact-check says grounded; any other model call (the report's
// recommendation section) gets a plain line.
export const ai = installFakeAiFetch()
export const script: unknown[] = []
export const driftCalls: AiRequest[] = []
ai.reply(req => {
  if (req.url.includes('openai.com')) {
    return systemPromptOf(req).includes('Generate a 4-7 word title') ? openAiChat('Buyer Report Chat') : openAiChat({})
  }
  if (systemPromptOf(req).startsWith('You are a fact-checker')) return anthropicText(JSON.stringify({ isGrounded: true, flags: [] }))
  if (!Array.isArray(req.body.tools)) return anthropicText('Keep the search as it is for now.')
  driftCalls.push(req)
  const next = script.shift()
  if (!next) throw new Error('test: no scripted Drift reply left')
  return next
})

// An Anthropic message with several tool calls in one round.
export const anthropicTools = (...uses: Array<[string, unknown]>) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-test',
  content: uses.map(([name, input], i) => ({ type: 'tool_use', id: `toolu_pr9_${i}`, name, input })),
  stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
})

export function reset(buyers: Row[]) {
  for (const k of Object.keys(fake.data)) delete fake.data[k]
  fake.data.organization = [{ id: ORG, slug: 'dealflow-ryan' }]
  fake.data.extractedOpportunity = buyers
  fake.calls.length = 0
  script.length = 0
  driftCalls.length = 0
}

// What the route sent back to Drift as tool results, in the order they came.
export function toolResultsSent(): Array<Record<string, unknown>> {
  const last = driftCalls[driftCalls.length - 1]?.body as { messages?: Array<{ role: string; content: unknown }> } | undefined
  return (last?.messages ?? [])
    .flatMap(m => (Array.isArray(m.content) ? m.content : []) as Array<{ type?: string; content?: string }>)
    .filter(b => b.type === 'tool_result')
    .map(b => JSON.parse(String(b.content)) as Record<string, unknown>)
}

export async function postChat(body: Record<string, unknown>) {
  const { POST } = await import('../route')
  const res = await POST(new NextRequest('http://localhost/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

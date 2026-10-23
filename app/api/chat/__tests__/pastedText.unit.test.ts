// Brief 43 PR 13 (Q22): through the real chat route, a long pasted email is
// read by Drift but doesn't drive the side lookups: no live StreetEasy search
// (paid), no CRM-seller block, no ACRIS or DOB lookup, no parser model call.
// Stand-ins only (harness.pr4.ts: in-memory Prisma, scripted Anthropic and
// OpenAI replies); any other request is recorded here and refused, never sent.
// [engineering precaution]
import { ai, resetTables } from './harness.pr4'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { systemPromptOf, type AiRequest } from '../../../../lib/__tests__/fakeAiFetch'
import { BLAST } from '../../../../lib/chat/context/__tests__/pastedEmail.fixture'

const aiFetch = globalThis.fetch
const outside: string[] = []
globalThis.fetch = ((input: unknown, init?: RequestInit) => {
  const url = String(input instanceof URL ? input.href : typeof input === 'string' ? input : (input as { url: string }).url)
  if (!/^https:\/\/api\.(openai|anthropic)\.com\//.test(url)) outside.push(url.split(/[?#]/)[0])
  return aiFetch(input as string, init)
}) as typeof fetch

async function post(message: string) {
  const { POST } = await import('../route')
  const res = await POST(new NextRequest('http://localhost/api/chat', { method: 'POST', body: JSON.stringify({ message }) }))
  assert.equal(res.status, 200)
  const main = ai.anthropic()[0]
  assert.ok(main, 'Drift was asked')
  return main
}
const isParserCall = (r: AiRequest) => systemPromptOf(r).startsWith('You are a NYC real estate query parser')

beforeEach(() => { resetTables(); ai.reset(); outside.length = 0 })

test('a pasted broker email reaches Drift but sets off no side lookup', async () => {
  const pasted = BLAST.replace('Hi all,', 'Hi all,\n\nWho owns 88 Example Ave? My buyer wants a rental in Williamsburg.')
  const main = await post(pasted)
  const system = systemPromptOf(main)
  assert.doesNotMatch(system, /LIVE STREETEASY/, 'no live StreetEasy search')
  assert.doesNotMatch(system, /YOUR CRM SELLERS/, 'no CRM-seller block')
  assert.deepEqual(outside, [], 'no ACRIS, DOB or StreetEasy request')
  assert.equal(ai.openai().filter(isParserCall).length, 0, 'no parser model call')
  assert.match(JSON.stringify(main.body.messages), /88 Example Ave/, 'Drift still reads the whole paste')
})

test('a paste that starts with a greeting gets no parser model call either', async () => {
  await post(BLAST.slice(BLAST.indexOf('Hi all,')))
  assert.equal(ai.openai().filter(isParserCall).length, 0)
  assert.deepEqual(outside, [])
})

test('a short question of Ryan\'s still gets its side lookups (the check above can see them)', async () => {
  const system = systemPromptOf(await post('my buyer wants a 2br in williamsburg'))
  assert.match(system, /LIVE STREETEASY/)
})

// Brief 43 PR 16 (review r1): when the AI refuses a message because of its PDF
// (a locked or damaged file: a 400 from Anthropic), Ryan gets a calm reply, not
// "Server error: ..." with the raw error. Any other failure is unchanged. The
// real chat route, fake Prisma, fake AI; no database, no network.
import { script, reset, postChat, db } from './pr8ChatHarness'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicTool } from '../../../../lib/__tests__/fakeAiFetch'
import { PDF_UNREADABLE_REPLY } from '../../../../lib/chat/fileBlocks'

// Anthropic answers 400 to any Drift call that carries a PDF (or, when
// refuseAll is set, to every Drift call).
let refuseAll = false
const inner = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url: string }).url
  const body = String(init?.body ?? '')
  if (url.includes('api.anthropic.com') && !body.includes('You are a fact-checker') && (refuseAll || body.includes('"type":"document"'))) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'test: the PDF specified was not valid' } }), { status: 400, headers: { 'content-type': 'application/json' } })
  }
  return inner(input as RequestInfo, init)
}) as typeof fetch

const pdf = { name: 'memo.pdf', mimeType: 'application/pdf', type: 'binary', content: Buffer.from('%PDF-1.4\nbroken').toString('base64') }

test('a PDF the AI refuses gets a calm reply, with no error text, and nothing is saved', async () => {
  reset(); refuseAll = false
  const { status, json } = await postChat({ message: 'what does this say?', files: [pdf] })
  assert.equal(status, 200)
  assert.equal(json.response, PDF_UNREADABLE_REPLY)
  assert.equal(PDF_UNREADABLE_REPLY, "I couldn't read that PDF. It may be locked or damaged. Try another copy, or paste the part you need.")
  assert.doesNotMatch(JSON.stringify(json), /invalid_request_error|not valid|Server error/)
  assert.equal(json.error, undefined)
  assert.equal(db.messages.length, 0)
})

test('the same refusal without a PDF is still a server error', async () => {
  reset(); refuseAll = true
  script.push(anthropicTool('drift_response', { response: 'unused', suggestions: [] }))
  const { status, json } = await postChat({ message: 'any matches?' })
  refuseAll = false
  assert.equal(status, 500)
  assert.notEqual(json.response, PDF_UNREADABLE_REPLY)
})

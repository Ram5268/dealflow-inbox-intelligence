// Brief 43 PR 4 (Q4): what the chat page says when /api/chat doesn't answer
// normally. Vercel's 504 (the 60-second stop) and 413 (body too big) come back
// as an HTML page, not JSON, which used to show only "Something went wrong".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatErrorReply, TIMEOUT_PAGE_REPLY, TOO_BIG_PAGE_REPLY, GENERIC_PAGE_REPLY } from '../chatErrorReply'

test('a 504 says it took too long, whatever the body', () => {
  assert.equal(TIMEOUT_PAGE_REPLY, 'That took too long, so I stopped. Try a narrower question.')
  assert.equal(chatErrorReply(504, null), TIMEOUT_PAGE_REPLY) // Vercel's HTML page: no JSON
  assert.equal(chatErrorReply(504, { response: 'Server error: x' }), TIMEOUT_PAGE_REPLY)
})

test('a 413 says the file is too big', () => {
  assert.match(TOO_BIG_PAGE_REPLY, /^That file is too big/)
  assert.equal(chatErrorReply(413, null), TOO_BIG_PAGE_REPLY)
})

test("other errors keep the server's own words, or a plain fallback", () => {
  assert.equal(chatErrorReply(500, { error: 'Error: x', response: 'Server error: Error: x' }), 'Server error: Error: x')
  assert.equal(chatErrorReply(429, { error: 'spend_limit', message: "Drift's daily spending limit is reached. It resets at midnight." }),
    "Drift's daily spending limit is reached. It resets at midnight.")
  assert.equal(chatErrorReply(502, null), GENERIC_PAGE_REPLY)
  assert.equal(chatErrorReply(500, { error: 'spend_limit' }), GENERIC_PAGE_REPLY, 'an error code is not shown')
  assert.equal(chatErrorReply(200, null), GENERIC_PAGE_REPLY, 'a 200 that is not JSON')
})

test('the page messages follow the feel standard', () => {
  for (const m of [TIMEOUT_PAGE_REPLY, TOO_BIG_PAGE_REPLY, GENERIC_PAGE_REPLY]) assert.doesNotMatch(m, /!|—/)
})

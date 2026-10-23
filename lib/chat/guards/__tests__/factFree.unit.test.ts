// Brief 43 PR 15 (Q31): the fact-check (a paid Sonnet call) is skipped only on
// a reply with nothing in it to check, on a turn that brought no facts. A price,
// a number, a name, an address, a draft or any tool or side-lookup facts keep it.
// Fictional names and addresses only. Pure.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFactFreeReply, factCheckNeeded } from '../factFree'

const quiet = { draft: null, toolCalls: 0, factLookups: 0 }

test('"thanks" and a greeting skip the fact-check', () => {
  for (const reply of [
    "You're welcome, Ryan.",
    'Good morning, Ryan.',
    'Good morning, Ryan. What would you like to look at today?',
    'Anytime. Anything else I can help with?',
    "Thanks, Ryan. I'm here when you need me.",
    'Hi Ryan, what can I do for you?',
    '',
  ]) {
    assert.equal(isFactFreeReply(reply), true, reply)
    assert.equal(factCheckNeeded({ reply, ...quiet }), false, reply)
  }
})

test('a reply with a price, a number or a number word keeps the fact-check', () => {
  for (const reply of [
    "It's asking $1,850,000.",
    'That one is listed at 1.2M.',
    'They want about two million for it.',
    'Rates are around six and a half percent today.',
    'I have three buyers who could fit.',
    'The second one works for your buyer.',
    'Price on request.',
    'It last sold a while back.',
  ]) {
    assert.equal(isFactFreeReply(reply), false, reply)
    assert.equal(factCheckNeeded({ reply, ...quiet }), true, reply)
  }
})

test('names, addresses, places and named sources keep the fact-check', () => {
  for (const reply of [
    'Sure, I can ask Pat Example about it.',
    'That home is on Example Ave.',
    'Bed-Stuy is a good fit for that.',
    'Good news: Jordan Sample likes it.',
    'ACRIS shows the deed.',
    'StreetEasy has it as active.',
    'The owner is happy to talk.',
    'See www.example.com for more.',
  ]) {
    assert.equal(isFactFreeReply(reply), false, reply)
  }
})

test('a draft, tool facts or side-lookup facts keep the fact-check, even on a plain reply', () => {
  const reply = "Here's a draft for you to copy."
  assert.equal(isFactFreeReply(reply), true)
  const draft = { channel: 'text', audience: 'buyer_side', body: 'Hi, I have a home that may suit your buyer. Ryan Martin' }
  assert.equal(factCheckNeeded({ reply, draft, toolCalls: 0, factLookups: 0 }), true, 'a draft')
  assert.equal(factCheckNeeded({ reply: 'Nothing new there.', draft: null, toolCalls: 1, factLookups: 0 }), true, 'a tool call')
  assert.equal(factCheckNeeded({ reply: 'Nothing new there.', draft: null, toolCalls: 0, factLookups: 1 }), true, 'a side lookup')
})

test('a long reply always gets the fact-check', () => {
  const reply = Array.from({ length: 40 }, () => 'happy to help with that').join(' and ')
  assert.equal(isFactFreeReply(reply), false)
})

test('review r1: purchase, transfer and sale history, and a name that starts a sentence, keep the fact-check', () => {
  for (const reply of [
    'Pat bought it in the spring.',
    'Yes, she bought it from her brother.',
    'She purchased the house from the estate.',
    'He inherited it from his parents.',
    'They closed on it last spring.',
    'It went into contract last week.',
    'Yes. Pat agreed to sell.',
    'Jordan called back.',
    'It is on maple street near the park.',
  ]) {
    assert.equal(isFactFreeReply(reply), false, reply)
  }
  for (const reply of ['Sounds good. Let me know.', 'Happy to help.', 'Got it.', 'Thank you, Ryan.', 'Sure thing.']) {
    assert.equal(isFactFreeReply(reply), true, reply)
  }
})

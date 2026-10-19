// Brief 43 PR 14 (Q38): Drift's reply text is cleaned before it is shown,
// stored or spoken: markdown and stray deal tags (as before), and now every
// em-dash (a comma, or nothing at a line's end) and every "!" (a period).
// Feel standard (Brief 42 TEST_PLAN §3): calm, no exclamation marks, no
// em-dashes. Pure; no network, no database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanReplyText } from '../replyText'

test('an em-dash between words becomes a comma', () => {
  assert.equal(cleanReplyText('Three in Bed-Stuy fit — the strongest is on Example Ave.'), 'Three in Bed-Stuy fit, the strongest is on Example Ave.')
  assert.equal(cleanReplyText('Nothing in Tribeca—rather quiet there.'), 'Nothing in Tribeca, rather quiet there.')
  assert.equal(cleanReplyText('The listing — a 3-family — is at $1,850,000.'), 'The listing, a 3-family, is at $1,850,000.')
})

test('an em-dash at the end of a line, before punctuation or after it, is dropped', () => {
  assert.equal(cleanReplyText('Two fit —\nThe first is coming soon.'), 'Two fit\nThe first is coming soon.')
  assert.equal(cleanReplyText('Two fit —.'), 'Two fit.')
  assert.equal(cleanReplyText('Two fit. — The first is coming soon.'), 'Two fit. The first is coming soon.')
  assert.equal(cleanReplyText('— The first is coming soon.'), 'The first is coming soon.')
  assert.equal(cleanReplyText('Not on file —'), 'Not on file')
})

test('"!" becomes a period, and "?!" a question mark', () => {
  assert.equal(cleanReplyText('Good news! Two fit!'), 'Good news. Two fit.')
  assert.equal(cleanReplyText('Two fit!!!'), 'Two fit.')
  assert.equal(cleanReplyText('Really?!'), 'Really?')
  assert.equal(cleanReplyText('Done!.'), 'Done.')
})

test('en-dashes in ranges stay, and so do hyphens', () => {
  const s = 'Replies run 2–5 sentences; the range is $1.2M–$1.5M in Bed-Stuy.'
  assert.equal(cleanReplyText(s), s)
})

test('a link keeps its characters', () => {
  const s = 'Here it is: https://www.streeteasy.com/building/example#!/unit-1 on StreetEasy.'
  assert.equal(cleanReplyText(s), s)
})

test('markdown and stray deal tags are stripped, as before', () => {
  assert.equal(cleanReplyText('**Two** fit, *both* in Bed-Stuy [DEAL:abc123].'), 'Two fit, both in Bed-Stuy.')
  assert.equal(cleanReplyText('Two fit.\n  [DEAL:a] [DEAL:b]\nWant buyers?'), 'Two fit.\nWant buyers?')
  assert.equal(cleanReplyText('An open tag [DEAL:abc stays.'), 'An open tag [DEAL:abc stays.')
})

test('plain replies are unchanged', () => {
  const s = 'Good morning, Ryan. What are we looking at today?'
  assert.equal(cleanReplyText(s), s)
  assert.equal(cleanReplyText(''), '')
})

test('long inputs stay fast (no runaway regex)', () => {
  const long = `${'a — '.repeat(5000)}${' '.repeat(10000)}x${' '.repeat(10000)}[DEAL:abc]!`
  const t0 = Date.now()
  cleanReplyText(long)
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`)
})

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

// Review r1: a dash next to a link was read as a line's start or end and
// dropped with its spaces, gluing the link to the next word ("…/sale/1234567 —
// 3 beds" became "…/sale/12345673 beds", a different listing).
test('a link next to an em-dash keeps its own characters and its space', () => {
  assert.equal(cleanReplyText('It is here: https://www.streeteasy.com/sale/1234567 — 3 beds at $1,850,000.'), 'It is here: https://www.streeteasy.com/sale/1234567, 3 beds at $1,850,000.')
  assert.equal(cleanReplyText('Open it — https://www.streeteasy.com/sale/1234567'), 'Open it, https://www.streeteasy.com/sale/1234567')
  assert.equal(cleanReplyText('https://a.example/x — first, then https://b.example/y!'), 'https://a.example/x, first, then https://b.example/y!')
  assert.equal(cleanReplyText('Line\nhttps://a.example/x\n— next'), 'Line\nhttps://a.example/x\nnext')
  assert.equal(cleanReplyText('Two links: https://a.example/x https://b.example/y.'), 'Two links: https://a.example/x https://b.example/y.')
})

test('a tight em-dash between numbers is a range (an en-dash); a spaced one is still a comma', () => {
  assert.equal(cleanReplyText('The range is $1.2M—$1.4M, with 2—3 beds, 9:00—10:00 AM.'), 'The range is $1.2M–$1.4M, with 2–3 beds, 9:00–10:00 AM.')
  assert.equal(cleanReplyText('Asking $1,850,000 — 2 buyers fit.'), 'Asking $1,850,000, 2 buyers fit.')
})

test('"!?" keeps its question mark, and "!" before an em-dash is not doubled up', () => {
  assert.equal(cleanReplyText('Really!?'), 'Really?')
  assert.equal(cleanReplyText('Two fit! — the first is coming soon.'), 'Two fit. the first is coming soon.')
})

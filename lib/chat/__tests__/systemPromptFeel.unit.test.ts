// Brief 43 PR 14: Drift's voice and feel, the report line, the hidden
// suggestions and the calendar lines, as text tests on SYSTEM_PROMPT, RYAN_MD
// and the per-turn Outlook notes. No network, no database, no AI calls.
//
// Rule sources:
// - N8: the report line reads "Done. Here's the Buyer Match report for
//   {buyer}." (Ryan's target wording, DRIFT_SCRIPT #15);
// - D7 [Brief 42 default]: no hidden follow-up suggestions;
// - D8 [Brief 42 default]: calendar off, so Drift says so and keeps the details
//   in chat; the pendingEvent lines only while Outlook is on (Q33);
// - the feel standard (Brief 42 TEST_PLAN §3, Q38): no stock openers, no
//   em-dashes, no exclamation marks, no system words in replies;
// - the greeting is Ryan's target wording for DRIFT_SCRIPT #1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SYSTEM_PROMPT } from '../systemPrompt'
import { RYAN_MD } from '../../prompts/ryanMd'
import { GRAPH_PAUSED_CALENDAR_BLOCK, GRAPH_ON_CALENDAR_NOTE } from '../../graphAccess'

const BOTH = `${SYSTEM_PROMPT}\n\n${RYAN_MD}`

// The paragraph holding `anchor`: from the line before it (its heading, when
// `withHeading`) to the next blank line.
function paragraph(text: string, anchor: string, withHeading = false): string {
  const at = text.indexOf(anchor)
  assert.ok(at >= 0, `found "${anchor}"`)
  let start = text.lastIndexOf('\n', at) + 1
  if (withHeading) start = text.lastIndexOf('\n', start - 2) + 1
  const end = text.indexOf('\n\n', at)
  return text.slice(start, end === -1 ? undefined : end)
}

test('N8: the report line is "Done. Here\'s the Buyer Match report for {buyer}." with the name alone', () => {
  const block = paragraph(SYSTEM_PROMPT, 'Presenting reports in your drift_response:')
  assert.ok(block.includes('"Done. Here\'s the Buyer Match report for {buyer}."'), block)
  // Review r1: the tool's subject is "<name> — <date>"; the reply carries the name only.
  assert.match(block, /buyer's name from the tool result's subject, without its date/)
  assert.ok(!BOTH.includes('Phase 1b'), 'no "Phase 1b"')
  assert.ok(!BOTH.includes('Report generated'), 'no "Report generated"')
  assert.doesNotMatch(block, /suggestion/i)
})

test('D7: Drift is never asked for follow-up suggestions', () => {
  assert.doesNotMatch(SYSTEM_PROMPT, /follow-up suggestions/i)
  assert.doesNotMatch(SYSTEM_PROMPT, /exactly two/i)
  assert.doesNotMatch(SYSTEM_PROMPT, /normal suggestions/i)
})

test('feel: no stock openers are prescribed; where they are named, it is to rule them out', () => {
  assert.ok(!SYSTEM_PROMPT.includes('Acknowledge briefly before delivering'))
  for (const line of BOTH.split('\n')) {
    if (/"(Certainly|Right away|Very good)\."/.test(line)) assert.match(line, /\b(no|never)\b/i, line)
  }
})

test('feel: the voice, report and reply-format lines carry no em-dash or "!"', () => {
  const blocks = [
    paragraph(SYSTEM_PROMPT, 'Tone: warm-formal', true),
    paragraph(SYSTEM_PROMPT, 'Presenting reports in your drift_response:'),
    paragraph(SYSTEM_PROMPT, 'Tool structure:'),
  ]
  for (const b of blocks) {
    assert.ok(!b.includes('—'), `no em-dash in:\n${b}`)
    assert.ok(!b.includes('!'), `no "!" in:\n${b}`)
  }
  // The rule itself is there: no em-dashes and no exclamation marks.
  const voice = blocks[0]
  assert.match(voice, /no em-dashes/i)
  assert.match(voice, /no exclamation marks/i)
})

test('feel: system words are banned in replies', () => {
  const line = SYSTEM_PROMPT.split('\n').find(l => l.includes('"tool results"'))
  assert.ok(line, 'a line names the system words')
  for (const w of ['"tool results"', '"opportunity"', '"counterpart"', '"isTestData"', '"Mojo"']) assert.ok(line.includes(w), w)
  assert.match(line, /\bnever\b/i)
})

test('greeting: Ryan\'s wording for "hey drift", with no search', () => {
  const greet = paragraph(RYAN_MD, 'GREETINGS (')
  assert.ok(greet.includes('"Good morning, Ryan. What are we looking at today?"'), greet)
  assert.match(greet, /no tool call/i)
})

test('D8: the static prompts never mention pendingEvent; the per-turn note decides', () => {
  assert.ok(!BOTH.includes('pendingEvent'), 'pendingEvent appears only in the Outlook-on note')
  assert.ok(!BOTH.includes('propose via'), 'no "propose via pendingEvent"')
  // Q33: RYAN_MD's calendar lines no longer say the calendar "auto-populates".
  const cal = paragraph(RYAN_MD, 'CALENDAR:')
  assert.doesNotMatch(cal, /auto-populates/)
  assert.match(cal, /CALENDAR note/)
  // Never claim a booking (Ryan, 2026-09-24: nothing contacts anyone).
  assert.match(SYSTEM_PROMPT, /never say an event is booked or added unless a calendar confirmation appears/i)
})

test('D8: while Outlook is off, Drift says so and keeps the details in chat', () => {
  assert.match(GRAPH_PAUSED_CALENDAR_BLOCK, /^\n\nCALENDAR: Outlook is paused/)
  assert.ok(GRAPH_PAUSED_CALENDAR_BLOCK.includes('"Your calendar isn\'t connected right now, so I can\'t book it. I\'ll keep the details here:'))
  assert.match(GRAPH_PAUSED_CALENDAR_BLOCK, /Never offer to book/)
  assert.ok(!GRAPH_PAUSED_CALENDAR_BLOCK.includes('pendingEvent'))
  assert.ok(!GRAPH_PAUSED_CALENDAR_BLOCK.includes('—'))
  // Only while Outlook is on: propose through pendingEvent, wait for a plain yes.
  assert.match(GRAPH_ON_CALENDAR_NOTE, /pendingEvent/)
  assert.match(GRAPH_ON_CALENDAR_NOTE, /plain yes/)
})

test('RYAN_MD\'s locked-template reply has no em-dash', () => {
  const line = RYAN_MD.split('\n').find(l => l.startsWith('"That\'s the [template name]'))
  assert.ok(line, 'the locked-template reply line')
  assert.ok(!line.includes('—'), line)
})

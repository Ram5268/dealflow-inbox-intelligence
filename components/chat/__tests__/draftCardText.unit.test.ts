import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draftHeading, draftCopyText, DRAFT_NOTE, COPY_FAILED } from '../draftCardText'

// Brief 43 PR 3: the words on the copyable draft block in chat. Pure.

const email = { channel: 'email' as const, audience: 'buyer_side' as const, subject: 'A 3-family in Bed-Stuy', body: 'Hi,\n\nPrice on request.\n\nRyan Martin' }
const text = { channel: 'text' as const, audience: 'homeowner' as const, body: 'Hi, this is Ryan Martin. Would you ever consider selling?' }

test('the heading says what kind of draft and who it is for', () => {
  assert.equal(draftHeading(email), 'Email draft for the buyer or their agent')
  assert.equal(draftHeading(text), 'Text draft for the homeowner')
  assert.equal(draftHeading({ ...text, audience: 'other' }), 'Text draft')
})

test('Copy copies the message; Copy subject copies the subject', () => {
  assert.equal(draftCopyText(email, 'body'), email.body)
  assert.equal(draftCopyText(email, 'subject'), 'A 3-family in Bed-Stuy')
  assert.equal(draftCopyText(text, 'subject'), '')
})

test('the notes are calm: nothing is sent, no exclamation marks or em-dashes', () => {
  assert.match(DRAFT_NOTE, /Nothing is sent/)
  for (const s of [DRAFT_NOTE, COPY_FAILED, draftHeading(email), draftHeading(text)]) assert.doesNotMatch(s, /!|—/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildReply, leadIn, levelOf, silenceBounds, splitSentences, spokenCount, stripMarkdown } from '../text'
import { VOICE_TIMING, shouldCommit } from '../config'

// Run: `npm run test:voice`. Brief 36 — sentence splitting, markdown
// stripping, lead-ins, silence trimming, highlight progress and commit timing.

test('splitSentences keeps punctuation and closing quotes on the sentence', () => {
  assert.deepEqual(splitSentences('Certainly. Two sellers fit! Want the first? “Yes.” Done'), [
    'Certainly.', 'Two sellers fit!', 'Want the first?', '“Yes.”', 'Done',
  ])
  assert.deepEqual(splitSentences('   '), [])
})

test('splitSentences does not break on street abbreviations or initials', () => {
  assert.deepEqual(splitSentences('The listing at 12 W. 96th St. is quiet. Mr. Lee owns it.'), [
    'The listing at 12 W. 96th St. is quiet.', 'Mr. Lee owns it.',
  ])
  assert.deepEqual(splitSentences('Asking $1.2 million. Good value.'), ['Asking $1.2 million.', 'Good value.'])
})

test('leadIn: up to four words ending in a colon, at the start only', () => {
  assert.equal(leadIn('Day One: Start with oatmeal.'), 'Day One:')
  assert.equal(leadIn('Bottom line: skip it.'), 'Bottom line:')
  assert.equal(leadIn('The three strongest leads right now: MacDonough.'), null, 'more than four words')
  assert.equal(leadIn('Showing at 12:30 works.'), null, 'a time is not a lead-in')
  assert.equal(leadIn('Sure. Here it is: done.'), null, 'sentence punctuation before the colon')
  assert.equal(leadIn('No colon here.'), null)
})

test('buildReply splits paragraphs and sentences and indexes them globally', () => {
  const r = buildReply('Sure! Here’s the plan.\n\nDay One: Oatmeal. Salad.\n\n\nWant more?')
  assert.deepEqual(r.sentences, ['Sure!', 'Here’s the plan.', 'Day One: Oatmeal.', 'Salad.', 'Want more?'])
  assert.deepEqual(r.paragraphs, [
    { lead: null, sentences: [0, 1] },
    { lead: 'Day One:', sentences: [2, 3] },
    { lead: null, sentences: [4] },
  ])
})

test('stripMarkdown leaves only speakable text', () => {
  assert.equal(stripMarkdown('**Day One:** try _this_ `now`'), 'Day One: try this now')
  assert.equal(stripMarkdown('# Heading\n- first\n2. second'), 'Heading first second')
  assert.equal(stripMarkdown('See [the listing](https://x.com/a) at https://streeteasy.com/b or www.foo.com today'), 'See the listing at or today')
})

test('silenceBounds trims leading/trailing silence with a little air', () => {
  const rate = 1000
  const data = new Float32Array(1000)
  data.fill(0.5, 250, 700) // sound from 250 to 699
  assert.deepEqual(silenceBounds(data, rate, 0.01, 0.02), [230, 720])
  assert.deepEqual(silenceBounds(new Float32Array(50), rate), [0, 50], 'all-silent clips are left alone')
  const edge = new Float32Array(10).fill(0.9)
  assert.deepEqual(silenceBounds(edge, rate, 0.01, 0.02), [0, 10], 'padding is clamped to the clip')
})

test('spokenCount: sentences whose start time has passed on the audio clock', () => {
  const starts = [1.0, 2.5, 4.0]
  assert.equal(spokenCount(starts, 0.5), 0)
  assert.equal(spokenCount(starts, 1.0), 1)
  assert.equal(spokenCount(starts, 3.9), 2)
  assert.equal(spokenCount(starts, 99), 3)
  assert.equal(spokenCount([], 5), 0)
})

test('levelOf: silence is 0, loud is capped at 1', () => {
  assert.equal(levelOf(new Uint8Array(64).fill(128)), 0)
  assert.equal(levelOf(new Uint8Array(64).fill(255)), 1)
  const mid = levelOf(new Uint8Array(64).map((_, i) => (i % 2 ? 140 : 116)))
  assert.ok(mid > 0 && mid < 1)
})

test('shouldCommit: waits for the live text to settle after speech end, capped', () => {
  const t = VOICE_TIMING
  const end = 10_000
  assert.equal(shouldCommit(end, end, 0), false, 'never at the instant of speech end')
  assert.equal(shouldCommit(end + t.commitStableMs, end, 0), true, 'stable since before speech end')
  assert.equal(shouldCommit(end + t.commitStableMs, end, end + 200), false, 'a delta just arrived')
  assert.equal(shouldCommit(end + 200 + t.commitStableMs, end, end + 200), true)
  assert.equal(shouldCommit(end + t.commitMaxWaitMs, end, end + t.commitMaxWaitMs - 1), true, 'capped even if deltas keep coming')
})

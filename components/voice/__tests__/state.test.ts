import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DIDNT_CATCH, initialVoiceState, voiceReducer, type VoiceEvent, type VoiceState } from '../state'

// Run: `npm run test:voice`. Brief 36 — every voice-mode transition, including
// mute, interrupt, error and close.

const run = (events: VoiceEvent[], from: VoiceState = initialVoiceState) => events.reduce(voiceReducer, from)
const listening = run([{ type: 'ready' }])
const hearing = run([{ type: 'speechStart' }, { type: 'delta', text: 'Show me' }, { type: 'delta', text: ' Bed-Stuy' }], listening)
const finalizing = run([{ type: 'speechEnd' }], hearing)
const thinking = run([{ type: 'final', text: '  Show me Bed-Stuy  ' }], finalizing)
const REPLY = 'Certainly. Two sellers fit.\n\nBottom line: the brownstone. Shall I go deeper?'
const speaking = run([{ type: 'reply', text: REPLY, interactionId: 'int-1' }], thinking)

test('connecting → ready → listening; stray events before ready are ignored', () => {
  assert.equal(initialVoiceState.phase, 'connecting')
  assert.equal(run([{ type: 'speechStart' }, { type: 'delta', text: 'x' }]).phase, 'connecting')
  assert.equal(listening.phase, 'listening')
  assert.equal(voiceReducer(listening, { type: 'ready' }), listening)
})

test('mic denied / connection failure / hourly limit → blocked; retry reconnects', () => {
  for (const reason of ['mic', 'connect', 'limit'] as const) {
    const blocked = voiceReducer(initialVoiceState, { type: 'blocked', reason })
    assert.equal(blocked.phase, 'blocked')
    assert.equal(blocked.blocked, reason)
    const again = voiceReducer(blocked, { type: 'retry' })
    assert.equal(again.phase, 'connecting')
    assert.equal(again.blocked, null)
  }
  assert.equal(voiceReducer(listening, { type: 'retry' }), listening, 'retry only applies when blocked')
  const lost = voiceReducer(speaking, { type: 'blocked', reason: 'connect' })
  assert.equal(lost.phase, 'blocked')
  assert.equal(lost.turns.length, 1, 'a lost link keeps the conversation on screen')
})

test('speech start → hearing; deltas build the live transcript; speech end → finalizing', () => {
  assert.equal(hearing.phase, 'hearing')
  assert.equal(hearing.live, 'Show me Bed-Stuy')
  assert.equal(voiceReducer(listening, { type: 'delta', text: 'noise' }), listening, 'no live text before the VAD hears speech')
  assert.equal(finalizing.phase, 'finalizing')
  assert.equal(voiceReducer(finalizing, { type: 'delta', text: ' please' }).live, 'Show me Bed-Stuy please', 'late tail still lands')
  assert.equal(voiceReducer(listening, { type: 'speechEnd' }), listening)
})

test('VAD misfire drops the utterance and returns to listening', () => {
  const s = voiceReducer(hearing, { type: 'misfire' })
  assert.equal(s.phase, 'listening')
  assert.equal(s.live, '')
})

test('final transcript opens a turn and moves to thinking; empty final returns to listening', () => {
  assert.equal(thinking.phase, 'thinking')
  assert.equal(thinking.live, '')
  assert.deepEqual(thinking.turns.map(t => [t.user, t.reply, t.spoken]), [['Show me Bed-Stuy', null, 0]])
  const empty = voiceReducer(finalizing, { type: 'final', text: '   ' })
  assert.equal(empty.phase, 'listening')
  assert.equal(empty.turns.length, 0)
  assert.equal(voiceReducer(listening, { type: 'final', text: 'late' }), listening, 'a final after timeout is ignored')
})

test('no final in time → gray "Didn’t catch that" and back to listening', () => {
  const s = voiceReducer(finalizing, { type: 'finalTimeout' })
  assert.equal(s.phase, 'listening')
  assert.equal(s.notice, DIDNT_CATCH)
  assert.equal(voiceReducer(s, { type: 'speechStart' }).notice, null, 'the notice clears when Ryan talks again')
})

test('reply → speaking with sentences; spoken count only grows; done darkens everything', () => {
  assert.equal(speaking.phase, 'speaking')
  const turn = speaking.turns[0]
  assert.equal(turn.interactionId, 'int-1')
  assert.deepEqual(turn.reply?.sentences, ['Certainly.', 'Two sellers fit.', 'Bottom line: the brownstone.', 'Shall I go deeper?'])
  const two = run([{ type: 'spoken', count: 2 }, { type: 'spoken', count: 1 }], speaking)
  assert.equal(two.turns[0].spoken, 2)
  const done = voiceReducer(two, { type: 'doneSpeaking' })
  assert.equal(done.phase, 'listening')
  assert.equal(done.turns[0].spoken, 4)
  assert.equal(voiceReducer(thinking, { type: 'spoken', count: 3 }), thinking)
})

test('interrupt stops mid-reply: unspoken sentences stay gray, listening resumes', () => {
  const s = run([{ type: 'spoken', count: 1 }, { type: 'interrupt' }], speaking)
  assert.equal(s.phase, 'listening')
  assert.equal(s.turns[0].spoken, 1)
  assert.equal(voiceReducer(listening, { type: 'interrupt' }), listening, 'taps outside speaking do nothing')
})

test('a chat failure shows the gray notice and returns to listening', () => {
  const s = voiceReducer(thinking, { type: 'failed', message: 'Drift couldn’t answer that. Try again.' })
  assert.equal(s.phase, 'listening')
  assert.equal(s.notice, 'Drift couldn’t answer that. Try again.')
  assert.equal(s.turns[0].reply, null)
})

test('mute: nothing is heard while muted; muting mid-utterance drops it; unmute restores', () => {
  const muted = voiceReducer(listening, { type: 'toggleMute' })
  assert.equal(muted.muted, true)
  assert.equal(run([{ type: 'speechStart' }, { type: 'delta', text: 'x' }], muted).phase, 'listening')
  for (const mid of [hearing, finalizing]) {
    const dropped = voiceReducer(mid, { type: 'toggleMute' })
    assert.equal(dropped.phase, 'listening')
    assert.equal(dropped.live, '')
    assert.equal(dropped.muted, true)
  }
  assert.equal(voiceReducer(muted, { type: 'toggleMute' }).muted, false)
  const mutedWhileSpeaking = voiceReducer(speaking, { type: 'toggleMute' })
  assert.equal(mutedWhileSpeaking.phase, 'speaking', 'muting the mic does not silence Drift')
})

test('close wins from every phase and freezes the state', () => {
  for (const s of [initialVoiceState, listening, hearing, finalizing, thinking, speaking]) {
    const closed = voiceReducer(s, { type: 'close' })
    assert.equal(closed.phase, 'closing')
    for (const e of [{ type: 'ready' }, { type: 'retry' }, { type: 'toggleMute' }, { type: 'doneSpeaking' }] as VoiceEvent[]) {
      assert.equal(voiceReducer(closed, e), closed)
    }
  }
})

test('a second turn appends; the previous reply keeps its highlight', () => {
  const done = run([{ type: 'spoken', count: 4 }, { type: 'doneSpeaking' }], speaking)
  const next = run([{ type: 'speechStart' }, { type: 'delta', text: 'yes' }, { type: 'speechEnd' }, { type: 'final', text: 'yes' }], done)
  assert.equal(next.phase, 'thinking')
  assert.deepEqual(next.turns.map(t => [t.id, t.user, t.spoken]), [[0, 'Show me Bed-Stuy', 4], [1, 'yes', 0]])
})

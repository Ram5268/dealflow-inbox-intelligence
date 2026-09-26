import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, readSettings, writeSettings } from '../settings'
import { THUMB_VOTE, feedbackBody } from '../feedback'

// Run: `npm run test:voice`. Brief 36 PR B — thumbs → vote mapping (reusing
// /api/chat/interaction's feedback schema) and voice-settings persistence.

test('thumbs map onto the existing feedback votes', () => {
  assert.deepEqual(THUMB_VOTE, { up: 'helpful', down: 'wrong_result' })
  assert.deepEqual(feedbackBody('int-1', 'up'), { interactionId: 'int-1', event: 'feedback', vote: 'helpful' })
  assert.deepEqual(feedbackBody('int-2', 'down'), { interactionId: 'int-2', event: 'feedback', vote: 'wrong_result' })
})

function memoryStore() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, m }
}

test('settings default to onyx at normal speed', () => {
  assert.deepEqual(readSettings(undefined), { voice: 'onyx', speed: 'normal' })
  assert.deepEqual(readSettings(memoryStore()), DEFAULT_SETTINGS)
})

test('settings round-trip through storage', () => {
  const store = memoryStore()
  writeSettings(store, { voice: 'cedar', speed: 'brisk' })
  assert.deepEqual(readSettings(store), { voice: 'cedar', speed: 'brisk' })
})

test('unknown or corrupt stored values fall back per field', () => {
  const store = memoryStore()
  store.setItem('dealflow.voiceSettings', JSON.stringify({ voice: 'robot', speed: 'toString' }))
  assert.deepEqual(readSettings(store), DEFAULT_SETTINGS)
  store.setItem('dealflow.voiceSettings', JSON.stringify({ voice: 'marin', speed: 3 }))
  assert.deepEqual(readSettings(store), { voice: 'marin', speed: 'normal' })
  store.setItem('dealflow.voiceSettings', '{not json')
  assert.deepEqual(readSettings(store), DEFAULT_SETTINGS)
  const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.deepEqual(readSettings(throwing), DEFAULT_SETTINGS)
  assert.doesNotThrow(() => writeSettings(throwing, DEFAULT_SETTINGS))
})

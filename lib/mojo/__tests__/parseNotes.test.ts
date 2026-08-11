import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseNotes, type NotesClient } from '../parseNotes'

// Run: `npm test` (ts-node via node:test). No real API calls — a fake client is
// injected, so this suite is free and deterministic. Emphasis: hallucination
// safety (null unless explicitly stated).

function fakeClient(json: string): NotesClient {
  return { messages: { create: async () => ({ content: [{ type: 'text', text: json }] }) } }
}

// A client that must never be called (asserts the short-circuit path).
const throwingClient: NotesClient = {
  messages: { create: async () => { throw new Error('LLM must not be called') } },
}

const ALL_NULL = {
  bedsMin: null, bedsMax: null, budgetMin: null, budgetMax: null,
  cashOnly: null, timing: null, initialNeighborhood: null,
}

// ── Short-circuit: notes under 20 chars skip the LLM entirely ─────────────────
test('empty notes → all null, no LLM call', async () => {
  const r = await parseNotes('', { client: throwingClient })
  assert.deepEqual(r, ALL_NULL)
})

test('short notes (<20 chars) → all null, no LLM call', async () => {
  const r = await parseNotes('nice guy', { client: throwingClient })
  assert.deepEqual(r, ALL_NULL)
})

// ── Explicit values are extracted ────────────────────────────────────────────
test('explicit values are extracted correctly', async () => {
  const client = fakeClient(JSON.stringify({
    bedsMin: 2, bedsMax: 3, budgetMin: 2000000, budgetMax: 3000000,
    cashOnly: true, timing: 'ASAP', initialNeighborhood: 'Chelsea',
  }))
  const r = await parseNotes('Wants 2-3BR in Chelsea, budget 2-3M, cash buyer, needs to move ASAP', { client })
  assert.equal(r.bedsMin, 2)
  assert.equal(r.bedsMax, 3)
  assert.equal(r.budgetMin, 2000000)
  assert.equal(r.budgetMax, 3000000)
  assert.equal(r.cashOnly, true)
  assert.equal(r.timing, 'ASAP')
  assert.equal(r.initialNeighborhood, 'Chelsea')
})

// ── Vague context stays null on the specific fields ──────────────────────────
test('vague context → null on unstated fields', async () => {
  // The model (correctly) returns null for fields not explicitly stated.
  const client = fakeClient(JSON.stringify({ ...ALL_NULL }))
  const r = await parseNotes('Chatted about the Chelsea deal, wants something affordable soon', { client })
  assert.deepEqual(r, ALL_NULL)
})

// ── Robustness: JSON wrapped in prose / code fence ───────────────────────────
test('JSON wrapped in prose is still parsed', async () => {
  const client = fakeClient('Here is the extraction:\n```json\n{"budgetMax": 1500000}\n```\nDone.')
  const r = await parseNotes('Looking up to 1.5M for a place downtown', { client })
  assert.equal(r.budgetMax, 1500000)
  assert.equal(r.bedsMin, null)
})

// ── Malformed model output → all null, never throws ──────────────────────────
test('unparseable model output → all null', async () => {
  const client = fakeClient('I could not extract anything useful from these notes.')
  const r = await parseNotes('Some notes that are long enough to hit the LLM path here', { client })
  assert.deepEqual(r, ALL_NULL)
})

test('wrong-typed fields are coerced to null', async () => {
  const client = fakeClient(JSON.stringify({ bedsMin: 'two', budgetMax: 'a lot', cashOnly: 'yes' }))
  const r = await parseNotes('Notes long enough to reach the LLM path for coercion test', { client })
  assert.equal(r.bedsMin, null)
  assert.equal(r.budgetMax, null)
  assert.equal(r.cashOnly, null)
})

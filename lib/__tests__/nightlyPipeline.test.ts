import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runSteps } from '../nightlyPipeline'

// Brief 35: each pipeline step runs in its own try/catch.

test('a failing step does not stop later steps; ok is false', async () => {
  const ran: string[] = []
  const r = await runSteps({
    crmLeadSync: async () => { ran.push('crm'); return { inserted: 0 } },
    scoring: async () => { ran.push('scoring'); throw new Error('boom') },
    callQueue: async () => { ran.push('queue'); return { queueLength: 50 } },
  })
  assert.deepEqual(ran, ['crm', 'scoring', 'queue'])
  assert.equal(r.ok, false)
  assert.deepEqual(r.steps.scoring, { ok: false, error: 'boom' })
  assert.deepEqual(r.steps.callQueue, { ok: true, result: { queueLength: 50 } })
})

test('all steps succeed → ok', async () => {
  const r = await runSteps({ a: async () => 1, b: async () => 2 })
  assert.deepEqual(r, { ok: true, steps: { a: { ok: true, result: 1 }, b: { ok: true, result: 2 } } })
})

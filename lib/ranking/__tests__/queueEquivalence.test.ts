// Must be the first import: it points lib/prisma at the in-memory stand-in.
import { current } from '../../__tests__/globalMemoryDb'
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryDb } from '../../__tests__/memoryDb'
import { buildCallQueue, type QueueScope } from '../queueBuilder'
import { FIXED_NOW, ORG, queueFixture } from './queueFixture'

// Brief 45 (PR E): the import-scoring route reuses buildCallQueue's per-contact
// logic, which this PR moves into a shared function. The nightly call list must
// not change at all, so this compares buildCallQueue's whole output, and every
// database call it makes, with a golden file recorded on main (66cdf07) before
// the move: same JSON text, key order included. No database. Re-record only on
// purpose: WRITE_GOLDEN=1.
const GOLDEN = join(__dirname, 'fixtures', 'callQueueGolden.json')

async function capture(limit: number, persist: boolean, scope: QueueScope) {
  current.mem = memoryDb(queueFixture())
  const r = await buildCallQueue(ORG, limit, persist, { scope })
  const calls = current.mem.calls.map(c => ({ model: c.model, op: c.op, args: c.args, tx: c.tx }))
  // The run id is random; everything else must match exactly.
  return JSON.parse(JSON.stringify({ result: r, calls }).split(r.generationRunId).join('RUN'))
}

test('buildCallQueue: same ranked list, stats, reads and writes as before Brief 45', async () => {
  mock.timers.enable({ apis: ['Date'], now: FIXED_NOW })
  try {
    const out = { crmPersisted: await capture(Infinity, true, 'crm'), allTop5: await capture(5, false, 'all') }
    const text = JSON.stringify(out, null, 2) + '\n'
    if (process.env.WRITE_GOLDEN === '1') writeFileSync(GOLDEN, text)
    assert.equal(text, readFileSync(GOLDEN, 'utf8'))
    // The fixture really exercises every branch (guards against a hollow golden).
    const stats = out.crmPersisted.result.stats
    assert.deepEqual(Object.keys(stats.exclusionCounts).sort(), ['all_phones_dnc', 'no_matches', 'status_do_not_call', 'tag_or_group_opt_out'])
    assert.equal(out.crmPersisted.result.entries.length, 8)
    assert.deepEqual(out.crmPersisted.calls.filter((c: { model: string }) => c.model === 'callQueueEntry').map((c: { op: string }) => c.op), ['deleteMany', 'createMany'])
  } finally {
    mock.timers.reset()
  }
})

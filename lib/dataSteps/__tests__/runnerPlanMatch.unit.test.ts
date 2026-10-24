// Brief 48 review (data steps): --apply writes exactly the plan the dry run
// printed. A fake database (no DB, no network): the step's plan is made twice,
// once in the dry run and once inside the write transaction.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { emptyBeforeCopy } from '../common'
import { EXIT, planDifferences, planFingerprint, runStep, type Step } from '../runner'

const ROOT = join(__dirname, '..', '..', '..') // this checkout

// Every statement, per transaction, in order.
const statements: string[][] = []
function fakeDb(): PrismaClient {
  return {
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      const mine: string[] = []
      statements.push(mine)
      return fn({
        $executeRawUnsafe: async (sql: string) => { mine.push(sql); return 0 },
        $queryRawUnsafe: async (sql: string) => { mine.push(sql); return sql.includes('"Organization"') ? [{ id: 'org-1' }] : [] },
      })
    },
  } as unknown as PrismaClient
}

// A step whose second plan (the one inside the write transaction) has `second` as its summary.
function step(first: Record<string, unknown>, second: Record<string, unknown>) {
  const calls = { plan: 0, apply: 0 }
  const s: Step<null> = {
    id: 'DS-1', title: 'test step', unit: 'rows', restoreAction: 'X', lockTables: ['Match', 'CallQueueEntry'],
    async plan() {
      calls.plan++
      return { plan: null, expect: 3, summary: calls.plan === 1 ? first : second, refusals: [], notices: [], mentions: null }
    },
    newCopy: (database, orgId, now) => emptyBeforeCopy('DS-1', database, orgId, now),
    async apply(_tx, _r, copy, save) { calls.apply++; return save(copy) },
    async check() { return { ok: true, counts: {} } },
  }
  return { s, calls }
}

async function run(first: Record<string, unknown>, second: Record<string, unknown>, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'b48-ds-runner-'))
  rmSync(dir, { recursive: true }) // the runner creates it owner-only
  const lines: string[] = []
  const { s, calls } = step(first, second)
  try {
    const code = await runStep(s, {
      db: fakeDb(), argv: ['node', 'x.ts', '--apply', '--expect', '3', '--preimage-dir', dir, ...extra], apply: true,
      database: 'b48_x_test', repoRoot: ROOT, log: l => lines.push(l),
    })
    let files = 0
    try { files = readdirSync(dir).length } catch { /* never created */ }
    return { code, calls, lines, files }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the same plan as the dry run is applied', async () => {
  const r = await run({ toRemove: 3, matches: 5, expect: 3 }, { toRemove: 3, matches: 5, expect: 3 })
  assert.equal(r.code, EXIT.ok)
  assert.equal(r.calls.apply, 1)
  assert.equal(r.files, 1)
})

test('a plan that moved since the dry run is refused, even when the --expect number is the same', async () => {
  // e.g. the nightly ran between the dry run and --apply: same duplicates, other matches
  const r = await run({ toRemove: 3, matches: 5, nested: { a: 1, b: 2 }, expect: 3 }, { toRemove: 3, matches: 9, nested: { a: 1, b: 7 }, expect: 3 })
  assert.equal(r.code, EXIT.refused)
  assert.equal(r.calls.apply, 0)
  assert.equal(r.files, 0)
  const refusal = r.lines.find(l => l.startsWith('Refusing'))
  assert.match(refusal ?? '', /changed since the dry run/)
  assert.match(refusal ?? '', /matches/)
  assert.match(refusal ?? '', /nested\.b/)
  assert.doesNotMatch(refusal ?? '', /\b9\b|\b7\b/) // names what moved, not the numbers
})

test('planDifferences names the parts that differ, recursively', () => {
  assert.deepEqual(planDifferences({ a: 1, b: { c: 2, d: [1, 2] } }, { a: 1, b: { c: 2, d: [1, 2] } }), [])
  assert.deepEqual(planDifferences({ a: 1, b: { c: 2, d: [1, 2] } }, { a: 2, b: { c: 2, d: [2, 1] }, e: 0 }), ['a', 'b.d', 'e'])
})

test('--plan <fingerprint>: the dry run\'s plan is applied; any other plan is refused before the write transaction', async () => {
  const plan = { toRemove: 3, matches: 5, expect: 3 }
  const ok = await run(plan, plan, ['--plan', planFingerprint(plan)])
  assert.equal(ok.code, EXIT.ok)
  assert.equal(ok.calls.apply, 1)
  assert.ok(ok.lines.includes(`Plan fingerprint: ${planFingerprint(plan)}`))
  // the executor's dry run saw 5 matches; by --apply time there are 9 (same --expect number)
  const moved = await run({ ...plan, matches: 9 }, { ...plan, matches: 9 }, ['--plan', planFingerprint(plan)])
  assert.equal(moved.code, EXIT.refused)
  assert.equal(moved.calls.apply, 0)
  assert.equal(moved.calls.plan, 1) // refused before the write transaction
  assert.equal(moved.files, 0)
  const bad = await run(plan, plan, ['--plan', 'xyz'])
  assert.equal(bad.code, EXIT.refused)
  assert.equal(bad.calls.plan, 0)
})

test("the write transaction locks the step's tables before its first query, so its snapshot comes after the lock", async () => {
  statements.length = 0
  const plan = { toRemove: 3, expect: 3 }
  const r = await run(plan, plan)
  assert.equal(r.code, EXIT.ok)
  const [dry, write] = statements
  assert.ok(!dry.some(s => s.startsWith('LOCK')), 'the dry run locks nothing')
  assert.ok(dry.includes('SET TRANSACTION READ ONLY'))
  const firstQuery = write.findIndex(s => !s.startsWith('SET '))
  assert.equal(write[firstQuery], 'LOCK TABLE "Match", "CallQueueEntry" IN SHARE ROW EXCLUSIVE MODE')
  assert.ok(write.findIndex(s => s.includes('"Organization"')) > firstQuery)
})

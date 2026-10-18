import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { assertSelectOnly, crmQuery } from '../roClient'

test('SELECT and WITH pass the text guard', () => {
  assert.doesNotThrow(() => assertSelectOnly('SELECT 1'))
  assert.doesNotThrow(() => assertSelectOnly('\n  with f as (select 1) select * from f'))
})

test('anything else is refused before reaching the CRM', () => {
  for (const s of ['UPDATE "Lead" SET name = 1', 'insert into x values (1)', 'DELETE FROM "Lead"', 'DROP TABLE "Lead"', 'BEGIN', ''])
    assert.throws(() => assertSelectOnly(s), /only permits SELECT\/WITH/, s)
})

// Brief 41.2 (PR C, audit M3): one statement per call. With no params node-pg
// uses the simple protocol, which runs every statement in the text, so a
// COMMIT would end the READ ONLY transaction and the rest would run outside it.
// Engineering precaution from the Oct 16, 2026 system-map review.
test('more than one statement is refused; one trailing ";" is fine', () => {
  for (const s of ['SELECT 1; COMMIT; DELETE FROM "Lead"', 'SELECT 1;DELETE FROM "Lead"', 'SELECT 1; COMMIT;',
    'with a as (select 1) select * from a; drop table "Lead"', 'SELECT 1;;', 'SELECT 1; ;'])
    assert.throws(() => assertSelectOnly(s), /only permits one statement/, s)
  for (const s of ['SELECT 1;', 'SELECT 1 ;', 'SELECT 1;\n  ', 'WITH f AS (SELECT 1) SELECT * FROM f;\n'])
    assert.doesNotThrow(() => assertSelectOnly(s), s)
})

test('a ";" inside a string literal or comment is refused too (fails closed)', () => {
  for (const s of [`SELECT ';' AS x`, 'SELECT 1 -- a; b', 'SELECT $$;$$'])
    assert.throws(() => assertSelectOnly(s), /only permits one statement/, s)
})

// The rest drives crmQuery against a fake pg client: no database. The setting
// points at a placeholder address nothing listens on (allowed in
// roSettingUsage.test.ts: this file only sets and deletes it).
process.env.DATABASE_URL_CRM_RO = 'postgres://nobody:nothing@127.0.0.1:9/no_such_db'
type Sent = { text: string; values?: unknown[]; queryMode?: string }
const sent: Sent[] = []
let connects = 0
let released = 0
let onStatement: (text: string) => Promise<unknown[]> = async () => []
const fakeClient = {
  query: async (q: string | Sent, values?: unknown[]) => {
    const c: Sent = typeof q === 'string' ? { text: q, values } : q
    sent.push(c)
    if (c.text === 'BEGIN READ ONLY' || c.text === 'ROLLBACK') return { rows: [] }
    return { rows: await onStatement(c.text) }
  },
  release: () => { released++ },
}
;(Pool.prototype as unknown as { connect: () => Promise<unknown> }).connect = async () => { connects++; return fakeClient }
const reset = () => { sent.length = 0; connects = 0; released = 0 }
after(() => { delete process.env.DATABASE_URL_CRM_RO })

test('crmQuery refuses a multi-statement string before it connects or sends BEGIN', async () => {
  for (const s of ['SELECT 1; COMMIT; DELETE FROM "Lead"', 'SELECT 1; COMMIT;']) {
    reset()
    await assert.rejects(crmQuery(s), /only permits one statement/, s)
    assert.equal(connects, 0, s)
    assert.deepEqual(sent, [], s)
  }
})

test('a WITH … DELETE still runs only inside BEGIN READ ONLY, with ROLLBACK after, even on error', async () => {
  reset()
  const sql = 'WITH d AS (DELETE FROM "Lead" RETURNING id) SELECT id FROM d'
  // What Postgres answers for a write inside a READ ONLY transaction.
  onStatement = async () => { throw Object.assign(new Error('cannot execute DELETE in a read-only transaction'), { code: '25006' }) }
  await assert.rejects(crmQuery(sql), /read-only transaction/)
  assert.deepEqual(sent.map(s => s.text), ['BEGIN READ ONLY', sql, 'ROLLBACK'])
  assert.equal(released, 1)
})

test('the statement goes over the extended protocol, so Postgres also refuses a second statement', async () => {
  reset()
  onStatement = async () => [{ one: 1 }]
  assert.deepEqual(await crmQuery('SELECT 1 AS one;\n'), [{ one: 1 }])
  assert.deepEqual(sent.map(s => s.text), ['BEGIN READ ONLY', 'SELECT 1 AS one;\n', 'ROLLBACK'])
  assert.equal(sent[1].queryMode, 'extended')
  assert.deepEqual(sent[1].values, [])
  reset()
  await crmQuery('SELECT $1::text AS v', ['dealflow-ryan'])
  assert.equal(sent[1].queryMode, 'extended')
  assert.deepEqual(sent[1].values, ['dealflow-ryan'])
  assert.equal(released, 1)
})

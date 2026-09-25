import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertSelectOnly } from '../roClient'

test('SELECT and WITH pass the text guard', () => {
  assert.doesNotThrow(() => assertSelectOnly('SELECT 1'))
  assert.doesNotThrow(() => assertSelectOnly('\n  with f as (select 1) select * from f'))
})

test('anything else is refused before reaching the CRM', () => {
  for (const s of ['UPDATE "Lead" SET name = 1', 'insert into x values (1)', 'DELETE FROM "Lead"', 'DROP TABLE "Lead"', 'BEGIN', ''])
    assert.throws(() => assertSelectOnly(s), /only permits SELECT\/WITH/, s)
})

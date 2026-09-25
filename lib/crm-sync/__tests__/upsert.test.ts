import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COLUMNS, DUPLICATES_SQL, LEGACY_SQL, REKEY_SQL, REMOVED_SQL, UPSERT_SQL, diffUpdates, toUpsertRow,
} from '../upsert'
import type { CrmContact } from '../mapLead'
import type { ExistingRow } from '../plan'

const flat = (s: string) => s.replace(/\s+/g, ' ')
const sql = flat(UPSERT_SQL)

test('insert supplies id and updatedAt, plus organizationId/intent/isTestData', () => {
  assert.match(sql, /INSERT INTO "MojoContact" AS m \(id, "mojoId", "organizationId", intent, "isTestData", "updatedAt",/)
  assert.match(sql, /SELECT id, "mojoId", \$2, 'SELLER', false, now\(\),/)
  assert.match(sql, /ON CONFLICT \("mojoId"\) DO UPDATE SET "updatedAt" = now\(\)/)
})

test('keep-old rule: every scalar column uses COALESCE(old, new)', () => {
  for (const [c, , mode] of COLUMNS) {
    if (mode === 'fill') assert.ok(sql.includes(`"${c}" = COALESCE(m."${c}", EXCLUDED."${c}")`), c)
  }
  assert.ok(sql.includes(`"metadata" = COALESCE(m."metadata", '{}'::jsonb) || EXCLUDED."metadata"`))
  assert.match(sql, /"additionalPhones" = CASE WHEN COALESCE\(m\."additionalPhones", '\{\}'\) = EXCLUDED\."additionalPhones"\[1:cardinality/)
})

test('neighborhood is written on insert only, never updated', () => {
  const setClause = sql.slice(sql.indexOf('DO UPDATE SET'), sql.indexOf(' WHERE NOT m."isTestData"'))
  assert.ok(!setClause.includes('"neighborhood" ='))
  assert.ok(sql.includes('"neighborhood" text'))
})

test('IS DISTINCT FROM guard skips unchanged rows; test data and other orgs are never updated', () => {
  assert.match(sql, /WHERE NOT m\."isTestData" AND m\."organizationId" = EXCLUDED\."organizationId" AND \(COALESCE/)
  assert.match(sql, /\) IS DISTINCT FROM \(m\."fullName", /)
})

test('rows travel as one jsonb parameter, far under the 32,766-value limit', () => {
  for (const s of [UPSERT_SQL, REKEY_SQL, DUPLICATES_SQL]) assert.match(s, /jsonb_to_recordset\(\$1::jsonb\)/)
  const placeholders = new Set(UPSERT_SQL.match(/\$\d+/g))
  assert.deepEqual([...placeholders].sort(), ['$1', '$2'])
})

test('metadata markers use COALESCE and skip test data', () => {
  assert.ok(flat(LEGACY_SQL).includes(`COALESCE(metadata, '{}'::jsonb) || '{"source":"legacy"}'::jsonb`))
  assert.ok(flat(LEGACY_SQL).includes(`NOT "isTestData" AND metadata->>'source' IS NULL`))
  assert.ok(flat(DUPLICATES_SQL).includes(`jsonb_build_object('source', 'duplicate', 'duplicateOf', v.keeper_id)`))
  assert.ok(flat(REMOVED_SQL).includes(`metadata->>'source' = 'crm'`))
  for (const s of [REKEY_SQL, DUPLICATES_SQL, LEGACY_SQL, REMOVED_SQL]) assert.ok(s.includes('NOT m."isTestData"') || s.includes('NOT "isTestData"'))
})

const contact = { mojoId: '14359', phones: ['3302342085', '9173312047'], emails: ['a@x.com'], neighborhood: null } as unknown as CrmContact
const keeper: ExistingRow = {
  id: 'keep', mojoId: '14359', fullName: 'A', address: null, state: null, zipCode: null,
  phone: '9173312047', additionalPhones: [], email: null, additionalEmails: null,
}

test('toUpsertRow: keeper keeps its id and phone; new numbers append; blank email filled', () => {
  const r = toUpsertRow({ contact, keeper })
  assert.equal(r.id, 'keep')
  assert.deepEqual([r.phone, r.additionalPhones], ['9173312047', ['3302342085']])
  assert.deepEqual([r.email, r.additionalEmails], ['a@x.com', []])
  assert.ok(!('phones' in r) && !('emails' in r))
})

test('toUpsertRow: a new lead gets a fresh id and the CRM lists as-is', () => {
  const r = toUpsertRow({ contact, keeper: null })
  assert.match(r.id, /^[0-9a-f-]{36}$/)
  assert.deepEqual([r.phone, r.additionalPhones], ['3302342085', ['9173312047']])
})

test('diffUpdates counts filled blanks and flags any changed existing value', () => {
  const ok = diffUpdates([
    { mojoId: '1', inserted: false, before: { unitCount: null, phone: '1', additionalPhones: ['2'], status: 'N/A', metadata: null },
      after: { unitCount: 2, phone: '1', additionalPhones: ['2', '3'], status: 'N/A', metadata: { source: 'crm' } } },
    { mojoId: '2', inserted: true, before: { unitCount: null }, after: { unitCount: 3 } },
  ])
  assert.deepEqual(ok, { filled: { unitCount: 1 }, changed: [] })
  const bad = diffUpdates([
    { mojoId: '3', inserted: false, before: { status: 'N/A', additionalPhones: ['2', '3'] },
      after: { status: 'Contact', additionalPhones: ['3', '2'] } },
  ])
  assert.deepEqual(bad.changed.sort(), ['3.additionalPhones', '3.status'])
})

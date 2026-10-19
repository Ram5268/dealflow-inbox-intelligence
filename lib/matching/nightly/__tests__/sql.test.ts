import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DELETE_STALE_MATCHES_OF_SELLERS_SQL, DELETE_STALE_MATCHES_SQL, EXISTING_MATCH_COUNTS_SQL, UPSERT_MATCHES_SQL } from '../sql'

const flat = (s: string) => s.replace(/\s+/g, ' ')
const upsert = flat(UPSERT_MATCHES_SQL)
const setClause = upsert.slice(upsert.indexOf('DO UPDATE SET'), upsert.indexOf(' WHERE m."opportunityType"'))

test('upsert keys on the Match unique key and never rewrites id, seen or createdAt', () => {
  assert.match(upsert, /ON CONFLICT \("opportunityId", "counterpartId", "counterpartType"\) DO UPDATE SET/)
  for (const col of ['id =', 'seen', '"createdAt"', '"opportunityType" =', '"organizationId" =']) {
    assert.ok(!setClause.includes(col), `SET must not touch ${col}`)
  }
  assert.ok(!upsert.includes('"seen"') && !upsert.includes('"createdAt"'), 'seen/createdAt come from DB defaults on insert')
})

test('upsert only rewrites rows whose scorer outputs changed (IS DISTINCT FROM guard)', () => {
  assert.match(upsert, /WHERE m\."opportunityType" = 'contact' AND m\."organizationId" = EXCLUDED\."organizationId" AND \(m\.score, m\.tier, m\.reason, m\."captureStatus", m\."matchFitConfidence", m\.contributions, m\."unknownFactors"\) IS DISTINCT FROM \(EXCLUDED\.score/)
  assert.match(upsert, /SELECT r\.id, \$2, r\."opportunityId", 'contact'/) // inserts are always contact supply
  assert.match(upsert, /jsonb_to_recordset\(\$1::jsonb\)/) // one parameter per chunk
})

test('stale-row delete is scoped to real contact supply only', () => {
  const del = flat(DELETE_STALE_MATCHES_SQL)
  assert.match(del, /DELETE FROM "Match" AS m USING "MojoContact" AS c/)
  assert.match(del, /m\."opportunityType" = 'contact' AND c\.id = m\."opportunityId" AND NOT c\."isTestData"/)
  assert.match(del, /m\."organizationId" = \$1/)
  assert.match(del, /NOT EXISTS \( SELECT 1 FROM jsonb_to_recordset\(\$2::jsonb\)/)
})

// Brief 45 (PR E): the import-scoring route rescores a few new sellers. It must
// never run the nightly delete (it would drop every other seller's matches),
// so it runs the same statement narrowed to the sellers it scored ($3).
test('the import path\'s stale-row delete is the nightly one, narrowed to the listed sellers', () => {
  assert.ok(DELETE_STALE_MATCHES_OF_SELLERS_SQL.startsWith(DELETE_STALE_MATCHES_SQL))
  const extra = flat(DELETE_STALE_MATCHES_OF_SELLERS_SQL.slice(DELETE_STALE_MATCHES_SQL.length)).trim()
  assert.equal(extra, 'AND m."opportunityId" IN (SELECT jsonb_array_elements_text($3::jsonb))')
})

test('the nightly stale-row delete is unchanged by Brief 45', () => {
  assert.equal(flat(DELETE_STALE_MATCHES_SQL).trim(), 'DELETE FROM "Match" AS m USING "MojoContact" AS c WHERE m."organizationId" = $1 ' +
    'AND m."opportunityType" = \'contact\' AND c.id = m."opportunityId" AND NOT c."isTestData" AND NOT EXISTS ( SELECT 1 FROM ' +
    'jsonb_to_recordset($2::jsonb) AS k("opportunityId" text, "counterpartId" text, "counterpartType" text) WHERE k."opportunityId" = ' +
    'm."opportunityId" AND k."counterpartId" = m."counterpartId" AND k."counterpartType" = m."counterpartType")')
})

// Brief 47 (PR 1): the size check compares tonight with exactly the rows the
// stale-row delete could remove (same WHERE, word for word).
test('the size check counts exactly the rows the stale-row delete can remove', () => {
  const del = flat(DELETE_STALE_MATCHES_SQL)
  const scope = del.slice(del.indexOf(' WHERE ') + ' WHERE '.length, del.indexOf(' AND NOT EXISTS'))
  assert.equal(scope, 'm."organizationId" = $1 AND m."opportunityType" = \'contact\' AND c.id = m."opportunityId" AND NOT c."isTestData"')
  assert.equal(flat(EXISTING_MATCH_COUNTS_SQL).trim(), 'SELECT count(*)::int AS matches, count(DISTINCT m."opportunityId")::int AS sellers ' +
    `FROM "Match" AS m, "MojoContact" AS c WHERE ${scope}`)
})

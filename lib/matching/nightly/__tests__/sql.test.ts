import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DELETE_STALE_MATCHES_SQL, UPSERT_MATCHES_SQL } from '../sql'

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

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertSelectOnly } from '../roClient'
import { OPT_OUTS_SQL, readCrmOptOutLeadIds } from '../crmReader'
import { mapLead, markOptOut } from '../mapLead'
import type { CrmLeadRow } from '../crmReader'

// Brief 43 PR 5 (D11 [Ryan, 2026-10-18]: opted-out sellers are marked "do not
// contact"; Q9, N3): the morning CRM sync now reads the CRM's own opt-out list
// (DncSuppression, source 'internal': STOP replies and opt-outs recorded in the
// CRM) through the existing read-only link, and marks those leads
// metadata.crmOptOut = true. Safe on a re-run and never wipes a mark: the key is
// only ever written as true, and the sync's metadata merge (old || new) keeps
// keys the new row doesn't carry. Pure: the query is faked; no database.
const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

test('the opt-out read is one read-only SELECT over the internal opt-out list, matched on the last 10 digits', () => {
  assert.doesNotThrow(() => assertSelectOnly(OPT_OUTS_SQL))
  const sql = flat(OPT_OUTS_SQL)
  assert.match(sql, /^SELECT DISTINCT c\."leadId" AS "leadId" FROM "DncSuppression" s/)
  assert.match(sql, /JOIN "Organization" o ON o\.id = s\."organizationId" AND o\.slug = \$1/)
  assert.match(sql, /JOIN "Contact" c ON c\."organizationId" = o\.id/)
  assert.ok(sql.includes(`s.source = 'internal'`))
  assert.ok(sql.includes(`right(regexp_replace(p.phone, '[^0-9]', '', 'g'), 10) = right(regexp_replace(s.phone, '[^0-9]', '', 'g'), 10)`))
  assert.ok(sql.includes(`length(regexp_replace(s.phone, '[^0-9]', '', 'g')) >= 10`))
  assert.ok(!/\b(insert|update|delete|truncate|alter|drop|grant)\b/i.test(sql))
  assert.deepEqual([...new Set(OPT_OUTS_SQL.match(/\$\d+/g))], ['$1'])
})

test('readCrmOptOutLeadIds: the lead ids, or null (never a throw) when the read fails', async () => {
  const seen: unknown[][] = []
  const ok = await readCrmOptOutLeadIds('dealflow-ryan', async (sql, params) => {
    seen.push([sql, params])
    return [{ leadId: 'lead_1' }, { leadId: 'lead_2' }] as never
  })
  assert.deepEqual([...(ok ?? [])].sort(), ['lead_1', 'lead_2'])
  assert.deepEqual(seen[0], [OPT_OUTS_SQL, ['dealflow-ryan']])
  const failed = await readCrmOptOutLeadIds('dealflow-ryan', async () => { throw new Error('permission denied for table') })
  assert.equal(failed, null)
})

test('readCrmOptOutLeadIds: a read that never answers gives null after the timeout, so the 7 am sync is not held up', async () => {
  const started = Date.now()
  const hung = await readCrmOptOutLeadIds('dealflow-ryan', () => new Promise(() => {}), 50)
  assert.equal(hung, null)
  assert.ok(Date.now() - started < 2_000)
  const { OPT_OUT_READ_TIMEOUT_MS } = await import('../crmReader')
  assert.ok(OPT_OUT_READ_TIMEOUT_MS <= 15_000)
})

const lead: CrmLeadRow = {
  id: 'lead_1', mojoId: '90001', name: 'Pat Example', displayName: 'Pat Example', primaryAddressFull: '88 Example Ave',
  updatedAt: '2026-10-18 09:00:00', contactName: null, phones: ['+17185550142'], emails: [], fields: {},
}

test('markOptOut: an opted-out lead gets crmOptOut true; anyone else is left exactly as mapLead made them (never false)', () => {
  const base = mapLead(lead)
  assert.equal('crmOptOut' in base.metadata, false)
  assert.equal(markOptOut(base, new Set(['lead_1'])).metadata.crmOptOut, true)
  assert.equal(markOptOut(base, new Set(['lead_other'])), base)
  assert.equal(markOptOut(base, null), base, 'a failed read changes nothing')
  // The value written is true or absent, so the jsonb merge can never clear a mark.
  const values = [markOptOut(base, new Set(['lead_1'])), markOptOut(base, new Set())].map(c => (c.metadata as Record<string, unknown>).crmOptOut)
  assert.deepEqual(values, [true, undefined])
})

test('the sync wires it in: opt-outs read alongside the leads, before the write, with a count in the result', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(__dirname, '../runSync.ts'), 'utf8')
  assert.match(src, /const \[leads, optOuts\] = await Promise\.all\(\[readCrmLeads\(ORG_SLUG\), readCrmOptOutLeadIds\(ORG_SLUG\)\]\)/)
  assert.match(src, /leads\.map\(mapLead\)\.map\(c => markOptOut\(c, optOuts\)\)/)
  assert.match(src, /optOutLeads: optOuts \? contacts\.filter\(c => c\.metadata\.crmOptOut\)\.length : null/)
})

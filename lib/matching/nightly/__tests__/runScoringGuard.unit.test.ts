// Must be the first import: it points lib/prisma at the in-memory stand-in.
import {
  BAD_VALUES, GOOD_VALUES, MOJO_BUYER, SELLERS, SWITCH_ON, crmSeller, current, legacyContact, nightlyWorld, oldMatch,
  orgTables, type NightlyWorld, type Tables, type Write,
} from './nightlyWorld'
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Row } from '../../../__tests__/memoryDb'
import { runNightlyScoring } from '../runScoring'

// Brief 47 (PR 1): nightly scoring's size check, end to end on the in-memory
// stand-in (no database). Before any write, the night is refused when it sees 0
// sellers or 0 buyers, or would keep fewer than half as many real-seller matches
// as the database holds, or leave fewer than half as many sellers with a match
// (engineering precaution, Brief 40 audit M6: on Sep 26 a night with no buyers
// deleted every real seller's matches and reported success). It compares sizes,
// never churn. A refused night writes one AuditLog row and nothing else, then
// throws; a dry run writes nothing. Every other night writes exactly what main
// wrote: the golden file below was recorded on main (f90b19c) before the change.
// Re-record only on purpose: WRITE_GOLDEN=1.
const GOLDEN = join(__dirname, 'fixtures', 'nightlyScoringGolden.json')
const REFUSED = 'NIGHTLY_SCORING_REFUSED' // CONTRACT.md: read by DealFlow's status page and the CRM's Queue notice

const omit = (o: Row, k: string): Row => Object.fromEntries(Object.entries(o).filter(([x]) => x !== k))
const pairKey = (m: Row) => `${m.opportunityId}|${m.counterpartId}|${m.counterpartType}`

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { warn, error } = console
  console.warn = () => {}
  console.error = () => {}
  try { return await fn() } finally { console.warn = warn; console.error = error }
}

type Night = { world: NightlyWorld; before: Tables; result?: Row; error?: Error }
async function night(tables: Partial<Tables>, { dryRun = false, testBuyers = true } = {}): Promise<Night> {
  if (testBuyers) process.env.SCORING_INCLUDE_TEST_BUYERS = 'true' // the test-data phase, as in production
  else delete process.env.SCORING_INCLUDE_TEST_BUYERS // go-live: test buyers turned off
  current.world = nightlyWorld(tables)
  const before = structuredClone(current.world.data)
  try {
    return { world: current.world, before, result: await quiet(() => runNightlyScoring({ dryRun })) as unknown as Row }
  } catch (e) {
    return { world: current.world, before, error: e as Error }
  }
}
const next = (n: Night, over: Partial<Tables> = {}): Partial<Tables> => ({ ...structuredClone(n.world.data), ...over })
const audits = (n: Night) => n.world.writes.filter(w => w.op === 'auditLog.create').map(w => (w.args as Row).action)

// A refused night: the error, then exactly one write (the refusal row), and the tables as they were but that row.
function assertRefused(n: Night, reasons: string[]): Row {
  assert.ok(n.error, 'the night must be refused')
  assert.equal(n.error.name, 'ScoringRefusedError')
  assert.equal(n.error.message, `scoring refused: ${reasons.join(', ')}`)
  assert.deepEqual(n.world.writes.map(w => w.op), ['auditLog.create'])
  assert.ok(n.world.calls.filter(c => c.op === 'auditLog.create').every(c => c.tx), 'the refusal row is written in the scoring transaction')
  const row = n.world.writes[0].args as Row
  assert.equal(row.action, REFUSED)
  assert.equal(row.organizationId, 'org-test')
  assert.deepEqual(n.world.data.match, n.before.match, 'no Match row written, updated or deleted')
  assert.deepEqual(omit(n.world.data as unknown as Row, 'auditLog'), omit(n.before as unknown as Row, 'auditLog'))
  const details = row.detailsJson as Row
  assert.deepEqual(details.reasons, reasons)
  return details
}

// What a normal night keeps on an empty Match table: the yardstick for the shrink cases.
async function tonight() {
  const n = await night(orgTables())
  assert.ok(n.result, 'the normal night passes')
  const rows = n.world.data.match
  const covered = [...new Set(rows.map(m => m.opportunityId as string))].sort()
  return { kept: rows.length, covered, rows }
}

test('0 sellers: refused before any write, with one AuditLog row of counts and codes', async () => {
  const n = await night(orgTables({ mojoContact: [MOJO_BUYER] }))
  const details = assertRefused(n, ['no_sellers'])
  assert.deepEqual(details, {
    reasons: ['no_sellers'], sellers: 0, buyers: 5, kept: 0, sellersCovered: 0,
    existingMatches: 0, existingSellersCovered: 0, includeTestBuyers: true,
  })
})

test('0 sellers with real sellers\' matches in the table: refused, every Match row kept', async () => {
  const legacy = [0, 1, 2].map(i => legacyContact(`legacy-${i}`, 60 + i))
  const n = await night(orgTables({
    mojoContact: [...legacy, MOJO_BUYER],
    match: legacy.flatMap(c => [oldMatch(c.id as string, 'buyer-a'), oldMatch(c.id as string, 'buyer-b')]),
  }))
  const details = assertRefused(n, ['no_sellers', 'matches_shrank', 'sellers_shrank'])
  assert.equal(details.existingMatches, 6)
  assert.equal(details.existingSellersCovered, 3)
})

test('0 buyers (test buyers turned off at go-live): refused, yesterday\'s matches stay', async () => {
  const { kept, covered } = await tonight()
  const yesterday = await night(orgTables())
  const n = await night(next(yesterday), { testBuyers: false })
  const details = assertRefused(n, ['no_buyers', 'matches_shrank', 'sellers_shrank'])
  assert.deepEqual(details, {
    reasons: ['no_buyers', 'matches_shrank', 'sellers_shrank'], sellers: SELLERS.length, buyers: 0, kept: 0, sellersCovered: 0,
    existingMatches: kept, existingSellersCovered: covered.length, includeTestBuyers: false,
  })
  assert.equal(n.world.data.match.length, kept)
  assert.ok(!audits(n).includes('NIGHTLY_SCORING'), 'no success row on a refused night')
})

test('fewer than half as many matches as the table holds: refused (matches_shrank)', async () => {
  const { kept, covered } = await tonight()
  // 2 × kept + 1 old pairs, all on tonight's sellers: the sellers count holds.
  const old = Array.from({ length: 2 * kept + 1 }, (_, i) => oldMatch(covered[i % covered.length], `buyer-gone-${i}`))
  const n = await night(orgTables({ match: old }))
  const details = assertRefused(n, ['matches_shrank'])
  assert.equal(details.kept, kept)
  assert.equal(details.existingMatches, 2 * kept + 1)
  assert.equal(details.existingSellersCovered, covered.length)
})

test('fewer than half as many sellers with a match: refused (sellers_shrank)', async () => {
  const { kept, covered } = await tonight()
  // One old pair for each of tonight's sellers, and for covered + 1 other real sellers.
  const others = Array.from({ length: covered.length + 1 }, (_, i) => legacyContact(`legacy-${i}`, 60 + i))
  assert.ok(2 * covered.length + 1 <= 2 * kept, 'fixture: the matches count must hold')
  const old = [...covered, ...others.map(c => c.id as string)].map(id => oldMatch(id, 'buyer-gone'))
  const n = await night(orgTables({ mojoContact: [...SELLERS, MOJO_BUYER, ...others], match: old }))
  const details = assertRefused(n, ['sellers_shrank'])
  assert.equal(details.sellersCovered, covered.length)
  assert.equal(details.existingSellersCovered, 2 * covered.length + 1)
})

test('exactly half as many matches and sellers passes, and the night is written', async () => {
  const { kept, covered } = await tonight()
  const others = covered.map((_, i) => legacyContact(`legacy-${i}`, 60 + i))
  const old = [
    ...Array.from({ length: kept }, (_, i) => oldMatch(covered[i % covered.length], `buyer-gone-${i}`)),
    ...Array.from({ length: kept }, (_, i) => oldMatch(others[i % others.length].id as string, `buyer-gone-${i}`)),
  ]
  const n = await night(orgTables({ mojoContact: [...SELLERS, MOJO_BUYER, ...others], match: old }))
  assert.equal(n.error, undefined)
  assert.equal(n.result?.kept, kept)
  assert.equal(n.result?.deleted, 2 * kept)
  assert.deepEqual(audits(n), ['NIGHTLY_SCORING'])
})

test('a high-churn night of the same size passes: every pair replaced, same counts', async () => {
  const { kept, covered, rows } = await tonight()
  // Yesterday: as many pairs, on the same sellers, none of them tonight's.
  const old = rows.map(r => oldMatch(r.opportunityId as string, `old-${r.counterpartId}`))
  const n = await night(orgTables({ match: old }))
  assert.equal(n.error, undefined)
  assert.equal(n.result?.kept, kept)
  assert.equal(n.result?.sellersCovered, covered.length)
  assert.equal(n.result?.inserted, kept)
  assert.equal(n.result?.updated, 0)
  assert.equal(n.result?.deleted, kept)
  assert.deepEqual(n.world.data.match.map(pairKey).sort(), rows.map(pairKey).sort())
  assert.deepEqual(n.world.writes.map(w => w.op), ['match.upsert', 'match.deleteStale', 'auditLog.create'])
})

test('a refused dry run writes nothing and still says it was refused', async () => {
  const yesterday = await night(orgTables())
  const n = await night(next(yesterday), { dryRun: true, testBuyers: false })
  assert.equal(n.error?.name, 'ScoringRefusedError')
  assert.equal(n.error?.message, 'scoring refused: no_buyers, matches_shrank, sellers_shrank')
  assert.deepEqual(n.world.writes, [])
  assert.deepEqual(n.world.data, n.before)
})

test('the switch on, refused: the refusal row carries the switch check; no rollback row; the switch stays as it was', async () => {
  // 241 old pairs: more than twice the most any night can keep (10 per seller), so every night here shrinks.
  const old = Array.from({ length: 241 }, (_, i) => oldMatch(SELLERS[i % SELLERS.length].id as string, `buyer-gone-${i}`))
  for (const values of [GOOD_VALUES, BAD_VALUES]) {
    const check = (await night(orgTables({ featureFlag: [SWITCH_ON], propertyValuation: values }))).result?.ourEstimates as Row
    assert.ok(check, 'the switch check runs on the normal night')
    const n = await night(orgTables({ featureFlag: [SWITCH_ON], propertyValuation: values, match: old }))
    assert.equal(n.error?.name, 'ScoringRefusedError')
    assert.deepEqual(n.world.writes.map(w => w.op), ['auditLog.create'])
    const details = (n.world.writes[0].args as Row).detailsJson as Row
    assert.ok((details.reasons as string[]).includes('matches_shrank'))
    assert.deepEqual(details.ourEstimates, check, 'the same check a normal night would record')
    assert.deepEqual(n.world.data.featureFlag, [SWITCH_ON], 'a refused night never touches the switch')
  }
})

test('the count is read once, in the scoring transaction, before the first write', async () => {
  const n = await night(orgTables({ match: [oldMatch('seller-00', 'buyer-gone')] }))
  assert.equal(n.error, undefined)
  const ops = n.world.calls.map(c => c.op)
  assert.equal(ops.filter(o => o === 'match.counts').length, 1)
  const count = ops.indexOf('match.counts')
  assert.ok(count < ops.indexOf('match.upsert'))
  assert.equal(n.world.calls[count].tx, true)
})

// ── A normal night writes exactly what main wrote ───────────────────────────

// Six of the sellers (two in Gowanus), to keep the golden file small.
const START = orgTables({
  mojoContact: [...SELLERS.slice(0, 6), MOJO_BUYER, crmSeller('seller-test', 50, { isTestData: true }), legacyContact('legacy-00', 60)],
  match: [
    oldMatch('seller-00', 'buyer-gone'), // a pair no longer kept: deleted
    oldMatch('seller-01', 'buyer-a'), // kept with new scorer outputs: updated
    oldMatch('legacy-00', 'buyer-a'), // a real non-CRM seller's: in the delete's scope
    oldMatch('seller-test', 'buyer-a'), // a test seller's: never touched
    oldMatch('elsewhere-01', 'buyer-a', { organizationId: 'org-other' }), // another org's: never touched
    oldMatch('eo-listing-1', 'seller-03', { opportunityType: 'opportunity', counterpartType: 'mojo' }), // inbox supply: never touched
  ],
})

// One line per Match row keeps the file small; the run time (ms) is left out.
const line = (r: Row) => JSON.stringify(r)
const stable = (w: Write) =>
  w.op === 'auditLog.create' ? { op: w.op, args: { ...(w.args as Row), detailsJson: omit((w.args as Row).detailsJson as Row, 'ms') } }
    : w.op === 'match.upsert' ? { op: w.op, args: (w.args as Row[]).map(line) } : w
const record = (n: Night) => ({
  result: n.result ? omit(n.result, 'ms') : null,
  error: n.error ? n.error.message : null,
  writes: n.world.writes.map(stable),
})
// Pre-existing rows keep their ids; new ones get a random id.
const table = (n: Night) => n.world.data.match
  .map(m => ({ ...m, id: String(m.id).startsWith('old-') ? m.id : 'NEW' }))
  .sort((a, b) => pairKey(a).localeCompare(pairKey(b)))
  .map(line)

test('normal nights (switch off, on, rolled back; a dry run) write exactly what main wrote', async () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-19T09:00:00.000Z') })
  try {
    const off = await night(START)
    const again = await night(next(off)) // nothing changed since: no inserts, updates or deletes
    const on = await night(next(again, { featureFlag: [SWITCH_ON], propertyValuation: GOOD_VALUES }))
    const rolledBack = await night(next(on, { propertyValuation: BAD_VALUES }))
    const dry = await night(next(rolledBack), { dryRun: true })
    const out = {
      nights: { off: record(off), again: record(again), on: record(on), rolledBack: record(rolledBack), dry: record(dry) },
      matchTable: table(rolledBack),
      switchAfter: rolledBack.world.data.featureFlag,
    }
    const text = JSON.stringify(out, null, 2) + '\n'
    if (process.env.WRITE_GOLDEN === '1') writeFileSync(GOLDEN, text)
    assert.equal(text, readFileSync(GOLDEN, 'utf8'))
    // The fixture really exercises each path (guards against a hollow golden).
    assert.ok((off.result?.inserted as number) > 0 && (off.result?.updated as number) > 0 && (off.result?.deleted as number) > 0)
    assert.deepEqual([again.result?.inserted, again.result?.updated, again.result?.deleted], [0, 0, 0])
    assert.equal((on.result?.ourEstimates as Row).rolledBack, false)
    assert.equal((rolledBack.result?.ourEstimates as Row).rolledBack, true)
    assert.deepEqual(audits(rolledBack), ['VALUATION_SWITCH_ROLLBACK', 'NIGHTLY_SCORING'])
    assert.deepEqual(dry.world.writes, [])
  } finally {
    mock.timers.reset()
  }
})

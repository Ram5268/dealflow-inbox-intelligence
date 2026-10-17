import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ImportSchema, RowSchema, RunSchema, recheckGates, GATE_LIMITS, MAX_ROWS_PER_BATCH } from '../contract'
import { comp, facts, passingChecks, reasonRow, runInput, valuedRow } from './fakeDb'

// Brief 44: the import contract refuses anything off the whitelist.

const rowOk = (r: unknown) => RowSchema.safeParse(r).success

test('a valued row and each kind of no-value row pass', () => {
  assert.ok(rowOk(valuedRow('c1')))
  assert.ok(rowOk(reasonRow('c1', 'five_plus_units')))
  assert.ok(rowOk(reasonRow('c1', 'not_found')))
})

test('unknown fields are refused anywhere in a row', () => {
  assert.ok(!rowOk({ ...valuedRow('c1'), extra: 1 }))
  assert.ok(!rowOk({ ...valuedRow('c1'), facts: { ...facts(), ownerName: 'X' } }))
  assert.ok(!rowOk({ ...valuedRow('c1'), facts: { ...facts(), lastSale: { date: '2004-06-01', price: 1, buyer: 'X' } } }))
  assert.ok(!rowOk({ ...valuedRow('c1'), comps: [{ ...comp(), sellerName: 'X' }] }))
})

test('no name field can ride along in a row, its facts or its sales', () => {
  for (const k of ['ownerName', 'owner', 'partyName', 'grantor', 'grantee', 'fullName', 'name', 'phone', 'email']) {
    assert.ok(!rowOk({ ...valuedRow('c1'), [k]: 'X' }), k)
    assert.ok(!rowOk({ ...valuedRow('c1'), facts: { ...facts(), [k]: 'X' } }), `facts.${k}`)
    assert.ok(!rowOk({ ...valuedRow('c1'), comps: [{ ...comp(), [k]: 'X' }] }), `comps.${k}`)
  }
})

test('values must be a sane, ordered range', () => {
  assert.ok(!rowOk({ ...valuedRow('c1'), low: 1900000 }), 'low above value')
  assert.ok(!rowOk({ ...valuedRow('c1'), high: 1800000 }), 'high below value')
  assert.ok(!rowOk({ ...valuedRow('c1'), low: null }), 'missing low')
  assert.ok(!rowOk({ ...valuedRow('c1'), low: 800000 }), 'implausibly wide')
  assert.ok(!rowOk({ ...valuedRow('c1'), value: -5, low: -6, high: -4 }), 'negative')
  assert.ok(!rowOk({ ...valuedRow('c1'), reason: 'not_found' }), 'value with a reason')
  assert.ok(!rowOk({ ...valuedRow('c1'), bbl: null }), 'value without a tax lot')
})

test('a home without a value needs a known reason and carries no range or sales', () => {
  assert.ok(!rowOk({ ...reasonRow('c1', 'five_plus_units'), reason: null }))
  assert.ok(!rowOk({ ...reasonRow('c1', 'five_plus_units'), reason: 'too_expensive' }))
  assert.ok(!rowOk({ ...reasonRow('c1', 'five_plus_units'), low: 1 }))
  assert.ok(!rowOk({ ...reasonRow('c1', 'five_plus_units'), comps: [comp()] }))
  assert.ok(!rowOk({ ...reasonRow('c1', 'not_found'), bbl: '3018230045' }))
  assert.ok(!rowOk({ ...reasonRow('c1', 'five_plus_units'), bbl: null }))
})

test('field formats are checked', () => {
  assert.ok(!rowOk({ ...valuedRow('c1'), bbl: '301823004' }), 'short bbl')
  assert.ok(!rowOk({ ...valuedRow('c1'), bbl: '6018230045' }), 'no such borough')
  assert.ok(!rowOk({ ...valuedRow('c1'), contactId: 'c1; drop' }))
  assert.ok(!rowOk({ ...valuedRow('c1'), facts: { ...facts(), zoning: 'free text here' } }))
  assert.ok(!rowOk({ ...valuedRow('c1'), facts: { ...facts(), buildingClass: 'Two family' } }))
  assert.ok(!rowOk({ ...valuedRow('c1'), comps: Array.from({ length: 9 }, (_, i) => comp(i)) }), 'more than 8 sales')
  assert.ok(!rowOk({ ...valuedRow('c1'), comps: [{ ...comp(), date: '05/14/2026' }] }))
})

test('a batch holds 1 to 200 rows', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => valuedRow(`c${i}`))
  assert.ok(ImportSchema.safeParse({ action: 'rows', runId: 'vr_20261020T100000Z_test01', rows: rows(MAX_ROWS_PER_BATCH) }).success)
  assert.ok(!ImportSchema.safeParse({ action: 'rows', runId: 'vr_20261020T100000Z_test01', rows: rows(MAX_ROWS_PER_BATCH + 1) }).success)
  assert.ok(!ImportSchema.safeParse({ action: 'rows', runId: 'vr_20261020T100000Z_test01', rows: [] }).success)
  assert.ok(!ImportSchema.safeParse({ action: 'delete', runId: 'vr_20261020T100000Z_test01' }).success)
})

test('run metadata refuses personal-looking keys and unknown counts', () => {
  assert.ok(RunSchema.safeParse(runInput()).success)
  assert.ok(!RunSchema.safeParse(runInput({ metrics: { worst: [{ address: '1 X St', miss: 0.5 }] } })).success)
  assert.ok(!RunSchema.safeParse(runInput({ scoreboard: { ownerName: 'X' } })).success)
  assert.ok(!RunSchema.safeParse(runInput({ counts: { ...runInput().counts, medianValue: 1830000 } })).success)
  assert.ok(!RunSchema.safeParse(runInput({ runId: 'x' })).success)
})

test('gates are recomputed from their values, not trusted', () => {
  assert.equal(recheckGates(passingChecks()).passed, true)
  const lie = passingChecks().map(c => (c.key === 'typical_miss_all' ? { ...c, value: 0.12, pass: true } : c))
  assert.equal(recheckGates(lie).passed, false, 'a reported pass over the limit still fails')
  const edge = passingChecks().map(c => (c.key === 'range_coverage' ? { ...c, value: GATE_LIMITS.range_coverage.max! } : c))
  assert.equal(recheckGates(edge).passed, true, 'the limit itself passes')
  const low = passingChecks().map(c => (c.key === 'range_coverage' ? { ...c, value: 0.59 } : c))
  assert.equal(recheckGates(low).passed, false)
  const few = passingChecks().map(c => (c.key === 'sellers_valued' ? { ...c, value: 1299 } : c))
  assert.equal(recheckGates(few).passed, false)
  assert.equal(recheckGates(passingChecks().slice(1)).passed, false, 'a missing gate fails')
  assert.equal(recheckGates([...passingChecks(), passingChecks()[0]]).passed, false, 'a repeated gate fails')
  assert.equal(recheckGates(null).passed, false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ImportSchema, RowSchema, RunSchema, recheckGates, issueList, GATE_LIMITS, MAX_ROWS_PER_BATCH } from '../contract'
import { comp, facts, passingChecks, reasonRow, runInput, sources, valuedRow } from './fakeDb'

// Brief 44: the import contract refuses anything off the whitelist.

const rowOk = (r: unknown) => RowSchema.safeParse(r).success
const runOk = (over: Record<string, unknown>) => RunSchema.safeParse(runInput(over)).success

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

test('facts carry no tax-lien field (Brief 44 Revision 5: data minimization)', () => {
  assert.ok(!rowOk({ ...valuedRow('c1'), facts: { ...facts(), taxLienNotice: false } }))
  assert.ok(!rowOk({ ...valuedRow('c1'), facts: { ...facts(), taxLienNotice: true } }))
})

test('values must be a sane, ordered range', () => {
  assert.ok(!rowOk({ ...valuedRow('c1'), low: 1900000 }), 'low above value')
  assert.ok(!rowOk({ ...valuedRow('c1'), high: 1800000 }), 'high below value')
  assert.ok(!rowOk({ ...valuedRow('c1'), low: null }), 'missing low')
  assert.ok(!rowOk({ ...valuedRow('c1'), low: 800000 }), 'implausibly wide')
  assert.ok(!rowOk({ ...valuedRow('c1'), value: -5, low: -6, high: -4 }), 'negative')
  assert.ok(!rowOk({ ...valuedRow('c1'), reason: 'not_found' }), 'value with a reason')
  assert.ok(!rowOk({ ...valuedRow('c1'), bbl: null }), 'value without a tax lot')
  assert.ok(!rowOk({ ...valuedRow('c1'), facts: null }), 'value without facts')
})

test('a home without a value needs a known reason and carries no range or sales', () => {
  assert.ok(!rowOk({ ...reasonRow('c1', 'five_plus_units'), reason: null }))
  assert.ok(!rowOk({ ...reasonRow('c1', 'five_plus_units'), reason: 'too_expensive' }))
  assert.ok(!rowOk({ ...reasonRow('c1', 'five_plus_units'), low: 1 }))
  assert.ok(!rowOk({ ...reasonRow('c1', 'five_plus_units'), comps: [comp()] }))
  assert.ok(!rowOk({ ...reasonRow('c1', 'not_found'), bbl: '3018230045' }))
  assert.ok(!rowOk({ ...reasonRow('c1', 'not_found'), facts: facts() }))
  assert.ok(!rowOk({ ...reasonRow('c1', 'five_plus_units'), bbl: null }))
})

test('field formats are checked', () => {
  assert.ok(!rowOk({ ...valuedRow('c1'), bbl: '301823004' }), 'short bbl')
  assert.ok(!rowOk({ ...valuedRow('c1'), bbl: '6018230045' }), 'no such borough')
  assert.ok(!rowOk({ ...valuedRow('c1'), contactId: 'c1; drop' }))
  assert.ok(!rowOk({ ...valuedRow('c1'), contactId: 'c'.repeat(65) }))
  assert.ok(!rowOk({ ...valuedRow('c1'), facts: { ...facts(), zoning: 'free text here' } }))
  assert.ok(!rowOk({ ...valuedRow('c1'), facts: { ...facts(), buildingClass: 'Two family' } }))
  assert.ok(!rowOk({ ...valuedRow('c1'), comps: Array.from({ length: 9 }, (_, i) => comp(i)) }), 'more than 8 sales')
  assert.ok(!rowOk({ ...valuedRow('c1'), comps: [{ ...comp(), date: '05/14/2026' }] }))
  assert.ok(!rowOk({ ...valuedRow('c1'), facts: { ...facts(), lastSale: { date: '2026-02-30', price: 610000 } } }), 'no such day')
})

test('a nearby sale starts with a house number, is within 1.5 miles and has a sane $/sq ft', () => {
  const withAddress = (address: string) => rowOk({ ...valuedRow('c1'), comps: [{ ...comp(), address }] })
  for (const a of ['200 SAMPLE AVENUE', '12-34 SAMPLE STREET', '12A SAMPLE PLACE', "45 O'SAMPLE COURT #2", '7 SAMPLE AVE.']) {
    assert.ok(withAddress(a), a)
  }
  for (const a of [
    'SAMPLE AVENUE', 'JOHN SMITH (SELLER) 718 555 0123', ' 200 SAMPLE AVENUE', '200SAMPLE AVENUE', '200 X', '-12 SAMPLE STREET',
    '200 SAMPLE AVENUE\n', `200 ${'A'.repeat(73)}`, '200 SAMPLE AVENUE; DROP', '12-34A-5 SAMPLE STREET',
  ]) {
    assert.ok(!withAddress(a), JSON.stringify(a))
  }
  const withComp = (over: Record<string, unknown>) => rowOk({ ...valuedRow('c1'), comps: [{ ...comp(), ...over }] })
  assert.ok(withComp({ distanceMiles: 1.5 }))
  assert.ok(!withComp({ distanceMiles: 1.51 }))
  assert.ok(!withComp({ distanceMiles: -0.1 }))
  assert.ok(!withComp({ pricePerSqft: 0 }))
  assert.ok(!withComp({ pricePerSqft: 50_001 }))
})

test('a batch holds 1 to 200 rows', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => valuedRow(`c${i}`))
  assert.ok(ImportSchema.safeParse({ action: 'rows', runId: 'vr_20261020T100000Z_test01', rows: rows(MAX_ROWS_PER_BATCH) }).success)
  assert.ok(!ImportSchema.safeParse({ action: 'rows', runId: 'vr_20261020T100000Z_test01', rows: rows(MAX_ROWS_PER_BATCH + 1) }).success)
  assert.ok(!ImportSchema.safeParse({ action: 'rows', runId: 'vr_20261020T100000Z_test01', rows: [] }).success)
  assert.ok(!ImportSchema.safeParse({ action: 'delete', runId: 'vr_20261020T100000Z_test01' }).success)
})

test('run metadata refuses unknown counts and bad run ids', () => {
  assert.ok(RunSchema.safeParse(runInput()).success)
  assert.ok(!runOk({ counts: { ...runInput().counts, medianValue: 1830000 } }))
  assert.ok(!runOk({ runId: 'x' }))
  assert.ok(!runOk({ extra: 1 }))
  assert.ok(!runOk({ expectedRows: 0 }))
  assert.ok(!runOk({ expectedRows: 20_001 }))
})

// A tree nested `depth` levels deep (the outer object is level 1).
const nested = (depth: number, leaf: unknown = 1): Record<string, unknown> => (depth <= 1 ? { x: leaf } : { x: nested(depth - 1, leaf) })

test('metrics and the scoreboard are number trees: numbers, yes/no and null only, no text anywhere', () => {
  const metricsOk = (metrics: unknown) => runOk({ metrics })
  const scoreboardOk = (scoreboard: unknown) => runOk({ scoreboard })
  assert.ok(metricsOk({ a: 1, b: { c: [1, 2.5, null, true] }, d: null, e: false, address_match_rate: 0.97, contacts: 1500 }))
  assert.ok(scoreboardOk(null))
  assert.ok(scoreboardOk({ upto: { recall: 0.98 } }))
  // The examples the review found accepted: text inside the blobs.
  assert.ok(!metricsOk({ worst: [{ addr: '123 Main St', who: 'John Smith', tel: '718' }] }))
  assert.ok(!metricsOk({ pairs: ['John Smith @ 123 Main St -> buyer Jane Doe'] }))
  assert.ok(!scoreboardOk({ a: { b: 'x' } }))
  assert.ok(!metricsOk({ a: [1, 'x'] }))
  assert.ok(!metricsOk({ feature_names: ['a', 'b'] }))
  assert.ok(!metricsOk({ a: '' }))
  // Keys are lowercase codes.
  for (const k of ['ownerName', 'owner name', 'John Smith', '_x', 'x-y', '', 'a'.repeat(49), '123 main st', 'é']) {
    assert.ok(!metricsOk({ [k]: 1 }), JSON.stringify(k))
    assert.ok(!scoreboardOk({ ok: { [k]: 1 } }), `nested ${JSON.stringify(k)}`)
  }
  assert.ok(metricsOk({ ['a'.repeat(48)]: 1 }))
  // Too deep is refused, never skipped: 6 levels pass, 7 don't.
  assert.ok(metricsOk(nested(6)))
  assert.ok(!metricsOk(nested(7)))
  assert.ok(metricsOk(nested(5, [1, 2])), 'a list at level 6')
  assert.ok(!metricsOk(nested(6, [1, 2])), 'a list at level 7')
  assert.ok(!metricsOk(nested(9, { ownerName: 'Secret Person' })), 'a name 9 levels down')
  let deepList: unknown = ['ownerName']
  for (let i = 0; i < 9; i++) deepList = [deepList]
  assert.ok(!metricsOk({ a: deepList }), 'a name inside 9 nested lists')
  assert.ok(!metricsOk({ a: [[1]] }), 'lists hold numbers, yes/no or null only')
  assert.ok(!metricsOk({ a: [{ b: 1 }] }))
  // Lists of at most 64, at most 64,000 bytes in all.
  assert.ok(metricsOk({ a: Array(64).fill(1) }))
  assert.ok(!metricsOk({ a: Array(65).fill(1) }))
  const big = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, Array(10).fill(123456.789)]))
  assert.ok(!metricsOk(big), 'over 64,000 bytes')
  // Only plain objects of finite numbers.
  for (const bad of [null, [], 'text', 1, { a: NaN }, { a: Infinity }, { a: new Date() }, { a: undefined }, { a: () => 1 }]) {
    assert.ok(!metricsOk(bad), String(bad))
  }
})

test('sources is strict: download and sales dates, a PLUTO version, a roll year and dataset ids with dates and row counts', () => {
  const sourcesOk = (s: unknown) => runOk({ sources: s })
  assert.ok(sourcesOk(sources()))
  assert.ok(sourcesOk(null))
  assert.ok(sourcesOk({ ...sources(), plutoVersion: null, rollFiscalYear: null, datasets: {} }))
  assert.ok(sourcesOk({ ...sources(), plutoVersion: '26v2.1' }))
  for (const v of ['26V2', 'v2', 'John Smith', '2026v2', '26v2.10', '']) assert.ok(!sourcesOk({ ...sources(), plutoVersion: v }), v)
  for (const y of [2019, 2101, 2027.5]) assert.ok(!sourcesOk({ ...sources(), rollFiscalYear: y }), String(y))
  assert.ok(!sourcesOk({ ...sources(), by: 'John Smith' }), 'unknown key')
  assert.ok(!sourcesOk({ ...sources(), mail: 'x@example.com' }), 'unknown key')
  assert.ok(!sourcesOk({ ...sources(), downloadedOn: undefined }), 'missing downloadedOn')
  assert.ok(!sourcesOk({ ...sources(), salesThrough: '09/30/2026' }))
  const withDataset = (id: string, entry: unknown = { updatedOn: null, rows: 1 }) => sourcesOk({ ...sources(), datasets: { [id]: entry } })
  assert.ok(withDataset('abcd-1234'))
  assert.ok(withDataset('dof_annual'))
  for (const id of ['John Smith', 'usep8jbt', 'USEP-8JBT', 'usep-8jbt-x', 'dof', '']) assert.ok(!withDataset(id), id)
  assert.ok(!withDataset('abcd-1234', { updatedOn: null, rows: 1, owner: 'x' }))
  assert.ok(!withDataset('abcd-1234', { updatedOn: null, rows: -1 }))
  assert.ok(!withDataset('abcd-1234', { updatedOn: null, rows: 1.5 }))
  assert.ok(!withDataset('abcd-1234', { updatedOn: '10/15/2026', rows: 1 }))
  assert.ok(!withDataset('abcd-1234', { rows: 1 }))
  assert.ok(!withDataset('abcd-1234', 'text'))
  assert.ok(withDataset('abcd-1234', { updatedOn: null, rows: 21_100_000 }), 'big city files')
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`ab${String(i).padStart(2, '0')}-1234`, { updatedOn: null, rows: 1 }]))
  assert.ok(sourcesOk({ ...sources(), datasets: many(30) }))
  assert.ok(!sourcesOk({ ...sources(), datasets: many(31) }))
  assert.ok(!sourcesOk({ ...sources(), datasets: [] }))
})

test('modelVersion is a short lowercase code (the public status page shows it)', () => {
  for (const v of ['dealflow-gbm90-v1', 'gbm90-v1', 'v1.2.3', 'a', 'a'.repeat(40)]) assert.ok(runOk({ modelVersion: v }), v)
  for (const v of ['123 Main St John Smith $1,830,000', 'Dealflow-v1', '', 'a'.repeat(41), '-v1', 'v1 2', 'v1\n', '.v1']) {
    assert.ok(!runOk({ modelVersion: v }), JSON.stringify(v))
  }
})

test('run dates make sense: data through no later than asOf and at most 62 days before it; asOf in 2026 or later', () => {
  assert.ok(runOk({ asOf: '2026-10-01', dataThrough: '2026-10-01' }))
  assert.ok(!runOk({ asOf: '2026-10-01', dataThrough: '2026-10-02' }), 'data through after asOf')
  assert.ok(runOk({ asOf: '2026-10-01', dataThrough: '2026-07-31' }), '62 days')
  assert.ok(!runOk({ asOf: '2026-10-01', dataThrough: '2026-07-30' }), '63 days')
  assert.ok(runOk({ asOf: '2026-01-01', dataThrough: '2025-12-31' }))
  assert.ok(!runOk({ asOf: '2025-12-31', dataThrough: '2025-12-30' }), 'before 2026')
  assert.ok(!runOk({ asOf: '2026-02-30' }), 'no such day')
  assert.ok(!runOk({ runAt: '2026-10-20T10:00:00' }), 'a run time without its offset')
  assert.ok(runOk({ runAt: '2026-10-20T06:00:00-04:00' }))
})

test('the gates are exactly the four, each once', () => {
  const checks = passingChecks()
  assert.ok(!runOk({ gates: { passed: true, checks: [checks[0], checks[0], checks[2], checks[3]] } }), 'one twice, one missing')
  assert.ok(!runOk({ gates: { passed: true, checks: checks.slice(1) } }), 'one missing')
  assert.ok(!runOk({ gates: { passed: true, checks: [...checks, checks[0]] } }), 'five')
  assert.ok(!runOk({ gates: { passed: true, checks: [{ ...checks[0], key: 'made_up' }, ...checks.slice(1)] } }))
  assert.ok(!runOk({ gates: { passed: true, checks: [{ ...checks[0], note: 'x' }, ...checks.slice(1)] } }))
  assert.ok(runOk({ gates: { passed: false, checks: [checks[3], checks[2], checks[1], checks[0]] } }), 'any order')
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

test('a refusal names where, never a value or an unknown key', () => {
  const MARK = 'Zqmarkerq'
  const start = (run: Record<string, unknown>) => ({ action: 'start', run: runInput(run) })
  const rows = (row: Record<string, unknown>) => ({ action: 'rows', runId: 'vr_20261020T100000Z_test01', rows: [{ ...valuedRow('c1'), ...row }] })
  const payloads: unknown[] = [
    rows({ facts: { ...facts(), [`${MARK}Name`]: 1 } }),
    rows({ [`${MARK} 718 555 0123`]: 1 }),
    rows({ comps: [{ ...comp(), address: `${MARK} SAMPLE AVENUE` }] }),
    rows({ comps: [{ ...comp(), [MARK]: 'x' }] }),
    rows({ reason: MARK }),
    rows({ contactId: `${MARK} Person` }),
    start({ metrics: { [MARK]: 1 } }),
    start({ metrics: { ok: { [`${MARK.toLowerCase()} st`]: 1 } } }),
    start({ metrics: { ok: MARK } }),
    start({ scoreboard: { a: [MARK] } }),
    start({ sources: { ...sources(), [MARK]: 1 } }),
    start({ sources: { ...sources(), datasets: { [MARK]: { updatedOn: null, rows: 1 } } } }),
    start({ sources: { ...sources(), datasets: { 'abcd-1234': { updatedOn: null, rows: 1, [MARK]: 1 } } } }),
    start({ modelVersion: MARK }),
    start({ counts: { ...runInput().counts, [MARK]: 1 } }),
    start({ gates: { passed: true, checks: [{ ...passingChecks()[0], [MARK]: 1 }, ...passingChecks().slice(1)] } }),
    start({ [MARK]: 1 }),
    { action: MARK },
    { action: 'publish', runId: `${MARK} 123 Main St` },
  ]
  for (const p of payloads) {
    const parsed = ImportSchema.safeParse(p)
    assert.ok(!parsed.success, JSON.stringify(p).slice(0, 120))
    const text = issueList(parsed.error).join('\n').toLowerCase()
    assert.ok(text.length > 0)
    assert.ok(!text.includes(MARK.toLowerCase()), `echoed: ${text}`)
  }
})

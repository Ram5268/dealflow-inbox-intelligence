// Brief 44 (PR 4): the USE_OUR_ESTIMATES switch and what it changes in nightly
// scoring (lib/matching/ourEstimates.ts). Pure functions, plus small stand-ins for
// the few Prisma calls. No database. Every home and value here is invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  USE_OUR_ESTIMATES, ROLLBACK_ACTION, switchIsOn, readOurEstimatesSwitch, newestPublishedValues, loadPublishedValues,
  applyOurEstimates, withOurEstimates, rollbackCheck, pickTonight, recordRollback, parseSwitchArgs, runSwitchCommand,
  MAX_VALUE_AGE_DAYS, recentEnough, type SwitchCheck,
} from '../ourEstimates'
import { precomputeSubstitutionCounts } from '../compsCache'
import { makeListing, makeBuyer, makeContext } from './fixtures'

const seller = (id: string, over: Parameters<typeof makeListing>[0] = {}) =>
  makeListing({ id, sourceType: 'contact', neighborhood: 'Park Slope', borough: 'Brooklyn', ...over })
const day = (d: string) => new Date(`${d}T12:00:00Z`)
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { warn, error } = console
  console.warn = () => {}
  console.error = () => {}
  try { return await fn() } finally { console.warn = warn; console.error = error }
}

// ── The switch ──────────────────────────────────────────────────────────────

test('the switch is on only when its row exists with enabled === true', () => {
  assert.equal(USE_OUR_ESTIMATES, 'USE_OUR_ESTIMATES')
  assert.equal(switchIsOn({ enabled: true }), true)
  const off: unknown[] = [null, undefined, {}, { enabled: false }, { enabled: null }, { enabled: 'true' }, { enabled: 1 }, { enabled: 'yes' }, true, 'true', 1, []]
  for (const row of off) assert.equal(switchIsOn(row), false, JSON.stringify(row))
})

test('reading the switch: one FeatureFlag read; a missing row, any other value or a failed read is off', async () => {
  const asked: unknown[] = []
  const db = (row: unknown) => ({ featureFlag: { findUnique: async (a: unknown) => { asked.push(a); return row } } })
  assert.equal(await readOurEstimatesSwitch(db({ id: USE_OUR_ESTIMATES, enabled: true }) as never), true)
  assert.deepEqual(asked, [{ where: { id: 'USE_OUR_ESTIMATES' }, select: { enabled: true } }])
  assert.equal(await readOurEstimatesSwitch(db(null) as never), false)
  assert.equal(await readOurEstimatesSwitch(db({ enabled: false }) as never), false)
  assert.equal(await readOurEstimatesSwitch(db({ enabled: 'true' }) as never), false)
  const failing = { featureFlag: { findUnique: async () => { throw new Error('connection reset') } } }
  assert.equal(await quiet(() => readOurEstimatesSwitch(failing as never)), false)
  assert.equal(await quiet(() => readOurEstimatesSwitch({} as never)), false) // no such table on this client
})

// ── Our published values ────────────────────────────────────────────────────

// The scoring run's clock in these tests (Brief 49: values older than 100 days are ignored).
const NOW = day('2026-10-25')
const published = (d: string | null) => ({ publishedAt: d ? day(d) : null })
const ROWS = [
  { contactId: 'a', value: 1_500_000, createdAt: day('2026-09-20'), run: published('2026-09-21') },
  { contactId: 'a', value: 1_600_000, createdAt: day('2026-10-20'), run: published('2026-10-21') }, // newest: used
  { contactId: 'b', value: 900_000, createdAt: day('2026-09-20'), run: published('2026-09-21') },
  { contactId: 'b', value: null, createdAt: day('2026-10-20'), run: published('2026-10-21') }, // newest has no value: none
  { contactId: 'c', value: 2_000_000, createdAt: day('2026-10-20'), run: published(null) }, // no publish time counts as oldest
  { contactId: 'c', value: 2_100_000, createdAt: day('2026-08-20'), run: published('2026-08-21') },
  { contactId: 'd', value: 0, createdAt: day('2026-10-20'), run: published('2026-10-21') }, // unusable: none
  { contactId: 'e', value: 1_100_000, createdAt: day('2026-10-19'), run: published('2026-10-21') },
  { contactId: 'e', value: 1_200_000, createdAt: day('2026-10-20'), run: published('2026-10-21') }, // same run time: the newer row
]

test("each seller's value comes from its newest published valuation, never an older month's", () => {
  const values = newestPublishedValues(ROWS, NOW)
  assert.deepEqual([...values].sort(), [['a', 1_600_000], ['c', 2_100_000], ['e', 1_200_000]])
  assert.deepEqual([...newestPublishedValues([...ROWS].reverse(), NOW)].sort(), [...values].sort()) // order doesn't matter
})

test("loadPublishedValues reads the organization's published runs only", async () => {
  const asked: unknown[] = []
  const db = { propertyValuation: { findMany: async (a: unknown) => { asked.push(a); return ROWS } } }
  const values = await loadPublishedValues(db as never, 'org-1', NOW)
  assert.deepEqual(asked, [{
    where: { organizationId: 'org-1', run: { published: true } },
    select: { contactId: true, value: true, createdAt: true, run: { select: { publishedAt: true } } },
  }])
  assert.equal(values.get('a'), 1_600_000)
  assert.equal(values.has('b'), false)
})

// ── Pricing the sellers ─────────────────────────────────────────────────────

test('applyOurEstimates prices a CRM seller by its value and marks it; the input is not changed', () => {
  const s = seller('s1')
  const [out] = applyOurEstimates([s], new Map([['s1', 1_800_000]]))
  assert.deepEqual(out, { ...s, price: 1_800_000, estimatedValue: 1_800_000, ourEstimate: true })
  assert.equal(s.price, null)
  assert.equal(s.estimatedValue, null)
  assert.equal(s.ourEstimate, undefined)
  // An older estimate on the record (e.g. Mojo's) gives way to ours.
  const [mojo] = applyOurEstimates([seller('s2', { price: 1_000_000, estimatedValue: 1_000_000 })], new Map([['s2', 1_250_000]]))
  assert.deepEqual([mojo.price, mojo.estimatedValue, mojo.ourEstimate], [1_250_000, 1_250_000, true])
})

test('applyOurEstimates skips last-asking sellers, sellers without a usable value, and email listings', () => {
  const expired = seller('e', { priorListingStatus: 'EXPIRED', priorListingPrice: 1_795_000 })
  const withdrawn = seller('w', { priorListingStatus: ' withdrawn ', priorListingPrice: 2_000_000 })
  const noValue = seller('n')
  const listing = makeListing({ id: 'o', sourceType: 'opportunity', neighborhood: 'Park Slope', price: 1_200_000 })
  const bad = ['z0', 'zneg', 'znan', 'zinf'].map(id => seller(id))
  const values = new Map([['e', 1_500_000], ['w', 1_500_000], ['o', 1_500_000], ['z0', 0], ['zneg', -1], ['znan', NaN], ['zinf', Infinity]])
  const before = [expired, withdrawn, noValue, listing, ...bad]
  const out = applyOurEstimates(before, values)
  assert.equal(out.length, before.length)
  out.forEach((l, i) => assert.equal(l, before[i], l.id)) // the same objects, untouched
  // EXPIRED with no usable last asking price has no last asking price: it gets our value.
  const [x] = applyOurEstimates([seller('x', { priorListingStatus: 'EXPIRED', priorListingPrice: null })], new Map([['x', 1_500_000]]))
  assert.equal(x.ourEstimate, true)
})

test('switch off: the inputs come back as they are, and no valuation is read', async () => {
  const reads: string[] = []
  const db = (row: unknown) => ({
    featureFlag: { findUnique: async () => { reads.push('flag'); return row } },
    propertyValuation: { findMany: async () => { reads.push('values'); return ROWS } },
  })
  const inputs = { listings: [seller('a')], buyers: [makeBuyer({ id: 'b1' })], ctx: makeContext(), other: 1 }
  for (const row of [null, { enabled: false }, { enabled: 'true' }]) {
    reads.length = 0
    const out = await withOurEstimates(db(row) as never, 'org-1', inputs)
    assert.equal(out, inputs)
    assert.deepEqual(reads, ['flag'])
  }
})

test('switch on: sellers priced by our values, few-alternatives counts redone with them, switch-off inputs kept', async () => {
  const listings = [seller('a'), seller('s-far'), seller('s-none'), makeListing({ id: 'o', neighborhood: 'Park Slope', price: 1_400_000 })]
  const buyers = [makeBuyer({ id: 'b1', neighborhoods: ['Park Slope'], priceMax: 1_600_000 })]
  const ctx = makeContext({ substitutionCounts: precomputeSubstitutionCounts(buyers, listings), now: NOW })
  assert.equal(ctx.substitutionCounts.get('b1'), 4) // unknown prices all count
  const rows = [...ROWS, { contactId: 's-far', value: 3_500_000, createdAt: day('2026-10-20'), run: published('2026-10-21') }]
  const db = { featureFlag: { findUnique: async () => ({ enabled: true }) }, propertyValuation: { findMany: async () => rows } }
  const inputs = { listings, buyers, ctx, other: 1 }
  const out = await withOurEstimates(db as never, 'org-1', inputs)
  assert.deepEqual(out.listings.map(l => [l.id, l.price, l.ourEstimate ?? false]), [
    ['a', 1_600_000, true], ['s-far', 3_500_000, true], ['s-none', null, false], ['o', 1_400_000, false],
  ])
  assert.equal(out.ctx.substitutionCounts.get('b1'), 3) // $3.5M can't fit "up to $1.6M"
  assert.equal(out.ctx.now, ctx.now)
  assert.equal(out.ctx.compsMedians, ctx.compsMedians)
  assert.equal(out.other, 1)
  assert.deepEqual(out.ourEstimates, { applied: 2, failed: false, without: { listings, ctx } })
  assert.equal(out.ourEstimates?.without.listings, listings)
  assert.equal(ctx.substitutionCounts.get('b1'), 4) // the switch-off context is untouched
})

test('switch on but our values unreadable: scored without them, marked as failed', async () => {
  const db = { featureFlag: { findUnique: async () => ({ enabled: true }) }, propertyValuation: { findMany: async () => { throw new Error('relation does not exist') } } }
  const inputs = { listings: [seller('a')], buyers: [], ctx: makeContext() }
  const out = await quiet(() => withOurEstimates(db as never, 'org-1', inputs))
  assert.equal(out.listings, inputs.listings)
  assert.equal(out.ctx, inputs.ctx)
  assert.deepEqual(out.ourEstimates, { applied: 0, failed: true, without: { listings: inputs.listings, ctx: inputs.ctx } })
})

// ── Brief 49 (PR 3): values older than 100 days are ignored ────────────────

const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000)
const aged = (contactId: string, value: number, days: number) =>
  ({ contactId, value, createdAt: daysBefore(NOW, days), run: { publishedAt: daysBefore(NOW, days) } })

test('a value is recent enough up to 100 days after its run was published, never without a publish time', () => {
  assert.equal(MAX_VALUE_AGE_DAYS, 100)
  assert.equal(recentEnough(daysBefore(NOW, 30), NOW), true)
  assert.equal(recentEnough(daysBefore(NOW, 100), NOW), true)
  assert.equal(recentEnough(new Date(daysBefore(NOW, 100).getTime() - 1), NOW), false)
  assert.equal(recentEnough(daysBefore(NOW, 101), NOW), false)
  assert.equal(recentEnough(daysBefore(NOW, -1), NOW), true) // a clock slightly behind the import's
  assert.equal(recentEnough(null, NOW), false)
})

test('switch on: a 101-day-old run is ignored and that seller is matched without a price; a 30-day-old run is used', async () => {
  const listings = [seller('old'), seller('recent'), seller('edge')]
  const rows = [aged('old', 1_500_000, 101), aged('recent', 1_600_000, 30), aged('edge', 1_700_000, 100)]
  const db = { featureFlag: { findUnique: async () => ({ enabled: true }) }, propertyValuation: { findMany: async () => rows } }
  const ctx = makeContext({ now: NOW })
  const out = await withOurEstimates(db as never, 'org-1', { listings, buyers: [], ctx })
  assert.deepEqual(out.listings.map(l => [l.id, l.price ?? null, l.ourEstimate ?? false]), [
    ['old', null, false], ['recent', 1_600_000, true], ['edge', 1_700_000, true],
  ])
  assert.equal(out.listings[0], listings[0]) // the stale seller passes through untouched, as before Brief 44
  assert.equal(out.ourEstimates?.applied, 2)
  // The newest run decides: an older run's value never stands in for a stale newer one.
  const later = await withOurEstimates({ ...db, propertyValuation: { findMany: async () => [aged('old', 1_400_000, 400), aged('old', 1_500_000, 101)] } } as never,
    'org-1', { listings: [seller('old')], buyers: [], ctx })
  assert.equal(later.ourEstimates?.applied, 0)
})

test('switch on: the age is measured against the scoring run\'s own clock', async () => {
  const rows = [aged('a', 1_500_000, 60)] // 60 days before NOW
  const db = { featureFlag: { findUnique: async () => ({ enabled: true }) }, propertyValuation: { findMany: async () => rows } }
  const run = async (now: Date) =>
    (await withOurEstimates(db as never, 'org-1', { listings: [seller('a')], buyers: [], ctx: makeContext({ now }) })).ourEstimates?.applied
  assert.equal(await run(NOW), 1)
  assert.equal(await run(new Date(NOW.getTime() + 41 * 86_400_000)), 0) // 101 days after publishing
})

test('loadPublishedValues ages values against today when no clock is given (the preview script)', async () => {
  const today = new Date()
  const rows = [
    { contactId: 'fresh', value: 1_000_000, createdAt: daysBefore(today, 1), run: { publishedAt: daysBefore(today, 1) } },
    { contactId: 'stale', value: 1_000_000, createdAt: daysBefore(today, 101), run: { publishedAt: daysBefore(today, 101) } },
  ]
  const values = await loadPublishedValues({ propertyValuation: { findMany: async () => rows } } as never, 'org-1')
  assert.deepEqual([...values.keys()], ['fresh'])
})

test('switch off: nothing changes and no valuation is read, whatever the values\' age', async () => {
  const reads: string[] = []
  const rows = [aged('a', 1_500_000, 101), aged('b', 1_600_000, 30)]
  const inputs = { listings: [seller('a'), seller('b')], buyers: [makeBuyer({ id: 'b1' })], ctx: makeContext({ now: NOW }) }
  for (const row of [null, { enabled: false }]) {
    reads.length = 0
    const db = {
      featureFlag: { findUnique: async () => { reads.push('flag'); return row } },
      propertyValuation: { findMany: async () => { reads.push('values'); return rows } },
    }
    const out = await withOurEstimates(db as never, 'org-1', inputs)
    assert.equal(out, inputs)
    assert.deepEqual(reads, ['flag'])
  }
})

// ── Automatic rollback (Brief 44 data step V4, step 4) ─────────────────────

const kept = (sellerId: string, fit: number) => ({ sellerId, matchFit: { matchFit: fit } })

test('rollback check: no rollback when our values cost fewer than half the HOT matches and few sellers', () => {
  const without = [kept('a', 90), kept('a', 85), kept('b', 82), kept('c', 70)]
  const check = rollbackCheck(without, [kept('a', 88), kept('b', 81), kept('c', 60)], 2)
  assert.deepEqual(check, {
    rolledBack: false, reasons: [], sellersPricedByOurValue: 2,
    hotWithout: 3, hotWith: 2, sellersWithMatchesWithout: 3, sellersLosingAllMatches: 0,
  })
})

test('rollback check: HOT matches below half of those without our values', () => {
  const without = [kept('a', 90), kept('b', 90), kept('c', 90), kept('d', 90)]
  assert.equal(rollbackCheck(without, [kept('a', 90), kept('b', 90), kept('c', 70), kept('d', 70)], 4).rolledBack, false) // exactly half
  const c = rollbackCheck(without, [kept('a', 90), kept('b', 79), kept('c', 70), kept('d', 70)], 4)
  assert.deepEqual([c.rolledBack, c.reasons, c.hotWith], [true, ['hot_halved'], 1])
})

test('rollback check: more than 10% of the sellers with matches end up with none', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `s${i}`)
  const without = ids.map(s => kept(s, 70))
  const one = rollbackCheck(without, ids.slice(1).map(s => kept(s, 70)), 10) // 1 of 10 = 10%: kept
  assert.deepEqual([one.rolledBack, one.sellersLosingAllMatches], [false, 1])
  const two = rollbackCheck(without, ids.slice(2).map(s => kept(s, 70)), 10) // 2 of 10 = 20%
  assert.deepEqual([two.rolledBack, two.reasons, two.sellersLosingAllMatches], [true, ['sellers_lost_matches'], 2])
  // Sellers who only gain matches with our values never count against them.
  assert.equal(rollbackCheck(without, [...without, kept('new', 90)], 10).rolledBack, false)
})

test('rollback check: scoring with our values failed, or gave a score that is not a number', () => {
  const without = [kept('a', 90)]
  assert.deepEqual(rollbackCheck(without, null, 3), {
    rolledBack: true, reasons: ['error'], sellersPricedByOurValue: 3,
    hotWithout: 1, hotWith: null, sellersWithMatchesWithout: 1, sellersLosingAllMatches: null,
  })
  assert.deepEqual(rollbackCheck(without, [kept('a', NaN)], 3).reasons, ['error'])
  // Both other rules at once.
  assert.deepEqual(rollbackCheck([kept('a', 90), kept('b', 90)], [], 2).reasons, ['hot_halved', 'sellers_lost_matches'])
  // Nothing to lose: no rollback.
  assert.equal(rollbackCheck([], [], 0).rolledBack, false)
})

test('tonight: our results unless they fail the check; then the results without our values', () => {
  const ok = { failed: false, applied: 1, without: { listings: [], ctx: makeContext() } }
  const withoutNight = { kept: [kept('a', 90)], pairs: 1 }
  const good = { kept: [kept('a', 92)], pairs: 1 }
  const bad = { kept: [], pairs: 1 }
  const picked = pickTonight(ok, () => good, () => withoutNight)
  assert.equal(picked.result, good)
  assert.equal(picked.check.rolledBack, false)
  const rolled = pickTonight(ok, () => bad, () => withoutNight)
  assert.equal(rolled.result, withoutNight)
  assert.deepEqual(rolled.check.reasons, ['hot_halved', 'sellers_lost_matches'])
  const threw = quietSync(() => pickTonight(ok, () => { throw new Error('boom') }, () => withoutNight))
  assert.equal(threw.result, withoutNight)
  assert.deepEqual(threw.check.reasons, ['error'])
  let called = false
  const failed = pickTonight({ ...ok, failed: true }, () => { called = true; return good }, () => withoutNight)
  assert.equal(called, false)
  assert.equal(failed.result, withoutNight)
  assert.deepEqual(failed.check.reasons, ['error'])
})

function quietSync<T>(fn: () => T): T {
  const { error } = console
  console.error = () => {}
  try { return fn() } finally { console.error = error }
}

test('a rollback writes one AuditLog row with counts only, then turns the switch off', async () => {
  const check: SwitchCheck = rollbackCheck([kept('a', 90), kept('b', 90)], [], 2)
  const writes: unknown[] = []
  const tx = {
    auditLog: { create: async (a: unknown) => { writes.push(['auditLog', a]) } },
    featureFlag: { updateMany: async (a: unknown) => { writes.push(['featureFlag', a]) } },
  }
  await recordRollback(tx as never, 'org-1', check)
  assert.equal(ROLLBACK_ACTION, 'VALUATION_SWITCH_ROLLBACK')
  assert.deepEqual(writes, [
    ['auditLog', { data: { organizationId: 'org-1', action: 'VALUATION_SWITCH_ROLLBACK', detailsJson: check } }],
    ['featureFlag', { where: { id: 'USE_OUR_ESTIMATES' }, data: { enabled: false } }],
  ])
  const codes = new Set(['error', 'hot_halved', 'sellers_lost_matches'])
  for (const [k, v] of Object.entries(check)) {
    const leaves = Array.isArray(v) ? v : [v]
    for (const x of leaves) assert.ok(typeof x === 'number' || typeof x === 'boolean' || x === null || codes.has(x as string), `${k}: ${x}`)
  }
})

// ── scripts/valuation-switch.ts ─────────────────────────────────────────────

test('switch script arguments: none, --on or --off', () => {
  assert.equal(parseSwitchArgs([]), null)
  assert.equal(parseSwitchArgs(['--on']), 'on')
  assert.equal(parseSwitchArgs(['--off']), 'off')
  for (const bad of [['--on', '--off'], ['--enable'], ['on'], ['--on', '--on'], ['--off', 'x']]) assert.equal(parseSwitchArgs(bad), 'usage', bad.join(' '))
})

test('switch script: shows the state; changes it only with --apply; prints only the state', async () => {
  const fake = (row: { enabled: boolean } | null) => {
    const writes: unknown[] = []
    return {
      writes,
      db: {
        featureFlag: {
          findUnique: async () => row,
          upsert: async (a: unknown) => { writes.push(a); return {} },
        },
      },
    }
  }
  let f = fake(null)
  assert.deepEqual(await runSwitchCommand(f.db as never, null, false), ['USE_OUR_ESTIMATES: off (no row)'])
  assert.deepEqual(await runSwitchCommand(f.db as never, 'on', false), ['USE_OUR_ESTIMATES: off (no row)', 'Dry run: nothing changed. Add --apply to turn it on.'])
  assert.deepEqual(f.writes, [])
  assert.deepEqual(await runSwitchCommand(f.db as never, 'on', true), ['USE_OUR_ESTIMATES: off (no row) -> on'])
  assert.deepEqual(f.writes, [{ where: { id: 'USE_OUR_ESTIMATES' }, update: { enabled: true }, create: { id: 'USE_OUR_ESTIMATES', enabled: true } }])
  assert.deepEqual(await runSwitchCommand(fake(null).db as never, 'off', true), ['USE_OUR_ESTIMATES: off (no row), unchanged'])
  f = fake({ enabled: true })
  assert.deepEqual(await runSwitchCommand(f.db as never, null, true), ['USE_OUR_ESTIMATES: on'])
  assert.deepEqual(await runSwitchCommand(f.db as never, 'on', true), ['USE_OUR_ESTIMATES: on, unchanged'])
  assert.deepEqual(await runSwitchCommand(f.db as never, 'off', true), ['USE_OUR_ESTIMATES: on -> off'])
  assert.deepEqual(f.writes, [{ where: { id: 'USE_OUR_ESTIMATES' }, update: { enabled: false }, create: { id: 'USE_OUR_ESTIMATES', enabled: false } }])
  f = fake({ enabled: false })
  assert.deepEqual(await runSwitchCommand(f.db as never, 'off', false), ['USE_OUR_ESTIMATES: off, unchanged'])
  assert.deepEqual(await runSwitchCommand(f.db as never, 'on', true), ['USE_OUR_ESTIMATES: off -> on'])
})

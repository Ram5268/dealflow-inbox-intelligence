import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOT_MIN_FIT, WARM_MIN_FIT } from '../tiers'
import { tierOf } from '../nightly/select'
import { tierCounts } from '../../push/digestCounts'
import {
  DEFAULT_MATCH_TAB, MATCHES_ORDER, MATCHES_PAGE_SIZE, MATCH_TABS, afterCursor, countsOf, decodeCursor, emptyState, encodeCursor,
  matchTier, matchesQuery, mergePage, partyBand, splitPage, sumCounts, tierParam, tierWhere,
} from '../matchesList'

// Brief 48 (PR 12, item 4.4): the Matches screen's tabs, paging and empty
// state, as pure functions. The tabs follow lib/matching/tiers.ts (HOT is 80 and
// up, WARM 65 to 79) [planner's fix list, approved by Ryan 2026-10-19; WARM as its
// own band and HOT first: executor, 2026-10-23]; the old tabs were GOLD 90+ and
// STRONG 70+. The list pages past its first 200.

test('the tabs are HOT 80+, WARM 65–79 and ALL, from tiers.ts; HOT is the default', () => {
  assert.deepEqual(MATCH_TABS.map(t => [t.id, t.label, t.tier]), [
    ['hot', 'HOT 80+', 'HOT'], ['warm', 'WARM 65–79', 'WARM'], ['all', 'ALL', null],
  ])
  assert.equal(HOT_MIN_FIT, 80)
  assert.equal(WARM_MIN_FIT, 65)
  assert.equal(DEFAULT_MATCH_TAB, 'hot')
  for (const t of MATCH_TABS) assert.ok(!/[!—]/.test(t.label), t.label)
})

// Rows as the nightly writes them (tier = tierOf(score)), rows with no tier, and
// old rows whose stored tier disagrees with today's thresholds (a 2026-08-11
// backfill set them at 90/70): each sits in exactly the tier its card, the
// digest (tierCounts) and Drift show.
const TIER_ROWS = [
  ...Array.from({ length: 101 }, (_, s) => ({ id: `n${s}`, score: s, tier: tierOf(s) as string | null })),
  ...Array.from({ length: 101 }, (_, s) => ({ id: `x${s}`, score: s, tier: null as string | null })),
  { id: 'old85', score: 85, tier: 'WARM' }, { id: 'old67', score: 67, tier: 'POSSIBLE' }, { id: 'seed80', score: 80, tier: 'WARM' },
]
function fitsTier(r: { score: number; tier: string | null }, w: Where): boolean {
  return (w.OR as Where[]).some(x => Object.entries(x).every(([k, v]) => {
    const val = (r as Record<string, unknown>)[k]
    if (v && typeof v === 'object') {
      const c = v as { gte?: number; lt?: number }
      return (c.gte === undefined || (val as number) >= c.gte) && (c.lt === undefined || (val as number) < c.lt)
    }
    return val === v
  }))
}

test('each tab is one tier: the stored tier, else the score, the same as the digest counts', () => {
  for (const r of TIER_ROWS) {
    const want = tierCounts([r])
    assert.equal(fitsTier(r, tierWhere('HOT')), want.hot === 1, `${r.id} HOT`)
    assert.equal(fitsTier(r, tierWhere('WARM')), want.warm === 1, `${r.id} WARM`)
    assert.equal(matchTier(r), want.hot ? 'HOT' : want.warm ? 'WARM' : 'POSSIBLE', r.id)
  }
  // No row is in both tabs.
  assert.equal(TIER_ROWS.filter(r => fitsTier(r, tierWhere('HOT')) && fitsTier(r, tierWhere('WARM'))).length, 0)
  assert.deepEqual([tierParam('hot'), tierParam('WARM'), tierParam('possible'), tierParam(''), tierParam(null), tierParam('80')],
    ['HOT', 'WARM', null, null, null, null])
})

test("the Parties view counts Hot and Warm by the same rule as the cards' tiers", () => {
  for (let score = 0; score <= 100; score++) assert.equal(partyBand({ tier: null, score }), tierOf(score).toLowerCase(), `score ${score}`)
  assert.deepEqual([79, 80, 64, 65, 89, 90].map(score => partyBand({ tier: null, score })), ['warm', 'hot', 'possible', 'warm', 'hot', 'hot'])
  assert.equal(partyBand({ tier: 'WARM', score: 85 }), 'warm') // the stored tier wins, as on the card
})

test('the query for a tab, the seen switch and a page', () => {
  assert.equal(matchesQuery({ tab: 'hot', unseenOnly: true }), 'unseen=1&tier=hot')
  assert.equal(matchesQuery({ tab: 'warm', unseenOnly: false }), 'tier=warm')
  assert.equal(matchesQuery({ tab: 'all', unseenOnly: false }), '')
  assert.equal(matchesQuery({ tab: 'all', unseenOnly: true, cursor: 'abc' }), 'unseen=1&after=abc')
})

test('a cursor round-trips; anything else is refused', () => {
  const row = { seen: false, score: 91, createdAt: new Date('2026-10-20T09:17:57.123Z'), id: 'match_0042' }
  assert.deepEqual(decodeCursor(encodeCursor(row)), { seen: false, score: 91, createdAt: '2026-10-20T09:17:57.123Z', id: 'match_0042' })
  assert.equal(encodeCursor(row), '0.91.1792487877123.match_0042')
  assert.deepEqual(decodeCursor('1.70.1792487877123.id.with.dots'), { seen: true, score: 70, createdAt: '2026-10-20T09:17:57.123Z', id: 'id.with.dots' })
  for (const bad of [null, undefined, '', 'not-a-cursor', '0.91.1792487877123', '0.91.1792487877123.', '2.91.1792487877123.m',
    'x.91.1792487877123.m', '0.1,5.1792487877123.m', '0..1792487877123.m', '0.091.1792487877123.m', '0.91.yesterday.m',
    '0.91.-5.m', '0.91.1e3.m', '0. 91.1792487877123.m', '0.91.9000000000000000.m']) {
    assert.equal(decodeCursor(bad), null, String(bad))
  }
})

// ── Paging, run the way the route runs it, against an in-memory list ──────────

type Row = { id: string; seen: boolean; score: number; createdAt: Date }
type Where = Record<string, unknown>
// Just enough of Prisma's where for afterCursor and the route's filters.
function fits(r: Row, w: Where): boolean {
  return Object.entries(w).every(([k, v]) => {
    if (k === 'OR') return (v as Where[]).some(x => fits(r, x))
    const val = (r as unknown as Record<string, unknown>)[k]
    const num = (x: unknown) => (x instanceof Date ? x.getTime() : x) as number | string
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const c = v as Record<string, unknown>
      if ('lt' in c) return num(val) < num(c.lt)
      if ('gt' in c) return num(val) > num(c.gt)
      if ('gte' in c) return num(val) >= num(c.gte)
      throw new Error(`unsupported ${JSON.stringify(c)}`)
    }
    return num(val) === num(v)
  })
}
function sortRows(rows: Row[]) {
  return [...rows].sort((a, b) => {
    for (const o of MATCHES_ORDER) {
      const [k, dir] = Object.entries(o)[0] as [keyof Row, 'asc' | 'desc']
      const x = a[k] instanceof Date ? (a[k] as Date).getTime() : (a[k] as number | string | boolean)
      const y = b[k] instanceof Date ? (b[k] as Date).getTime() : (b[k] as number | string | boolean)
      if (x !== y) return (x < y ? -1 : 1) * (dir === 'asc' ? 1 : -1)
    }
    return 0
  })
}
function getPage(rows: Row[], filter: Where, after: string | null, size: number) {
  const c = after ? decodeCursor(after) : null
  const where = c ? { ...filter, ...afterCursor(c) } : filter
  return splitPage(sortRows(rows.filter(r => fits(r, where))).slice(0, size + 1), size)
}
// Many ties on score and time, so the id decides; a mix of seen and unseen.
const ROWS: Row[] = Array.from({ length: 1_037 }, (_, i) => ({
  id: `m_${String((i * 7919) % 1_037).padStart(4, '0')}`, seen: i % 5 === 0, score: 50 + (i % 9) * 6,
  createdAt: new Date(Date.UTC(2026, 9, 1 + (i % 4), 9)),
}))

test('paging walks the whole list in order, with no row twice or missing', () => {
  for (const filter of [{}, { seen: false }, { score: { gte: 80 } }]) {
    const want = sortRows(ROWS.filter(r => fits(r, filter))).map(r => r.id)
    const got: string[] = []
    let after: string | null = null
    let pages = 0
    do {
      const { page, nextCursor } = getPage(ROWS, filter, after, 200)
      assert.ok(page.length <= 200)
      got.push(...page.map(r => r.id))
      after = nextCursor
      pages++
    } while (after && pages < 50)
    assert.deepEqual(got, want, JSON.stringify(filter))
    assert.ok(want.length > 200, 'more than one page')
  }
  assert.equal(MATCHES_PAGE_SIZE, 200)
})

test("opening matches while paging the unseen list skips none of the rest", () => {
  const rows = structuredClone(ROWS)
  const first = getPage(rows, { seen: false }, null, 200)
  // Ryan opens five cards on the first page (each turns seen), then asks for more.
  for (const r of first.page.slice(0, 5)) rows.find(x => x.id === r.id)!.seen = true
  const second = getPage(rows, { seen: false }, first.nextCursor, 200)
  const want = sortRows(ROWS.filter(r => !r.seen)).map(r => r.id).slice(200, 400)
  assert.deepEqual(second.page.map(r => r.id), want)
})

test('with seen matches shown, a match opened since can come round again: it is shown once', () => {
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' }
  assert.deepEqual(mergePage([a, b], [c, a]).map(x => x.id), ['a', 'b', 'c'])
  assert.deepEqual(countsOf([{ seen: false, counterpartType: 'mojo' }, { seen: true, counterpartType: 'opportunity' }, { seen: false, counterpartType: 'showing_confirmation' }]),
    { total: 3, unseen: 2, mojo: 1, listings: 1, showings: 1 })
  assert.deepEqual(sumCounts({ total: 2, unseen: 1, mojo: 0, listings: 2, showings: 0 }, { total: 3, unseen: 3, mojo: 1, listings: 2, showings: 0 }),
    { total: 5, unseen: 4, mojo: 1, listings: 4, showings: 0 })
})

test('the empty state is calm, plain English, and no longer sends Ryan to Check In', () => {
  const all: string[] = []
  for (const view of ['matches', 'parties'] as const) {
    for (const t of MATCH_TABS) {
      for (const unseenOnly of [true, false]) {
        const e = emptyState(view, t.id, unseenOnly)
        assert.ok(e.title && e.hint)
        all.push(e.title, e.hint)
      }
    }
  }
  for (const s of all) {
    assert.ok(!/[!—]/.test(s), s)
    assert.ok(!/check in|mojo|endpoint/i.test(s), s)
  }
  assert.deepEqual(emptyState('matches', 'hot', true), {
    title: 'No new HOT matches.',
    hint: 'DealFlow looks for new matches every morning. Tap Show seen to see the ones you have opened.',
  })
  assert.deepEqual(emptyState('matches', 'all', false), {
    title: 'No matches yet.',
    hint: 'DealFlow looks for new matches every morning.',
  })
  assert.deepEqual(emptyState('parties', 'warm', false), {
    title: 'No parties with WARM matches.',
    hint: 'DealFlow looks for new matches every morning. Try another tab or filter.',
  })
})

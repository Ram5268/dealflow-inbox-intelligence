import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOT_MIN_FIT, WARM_MIN_FIT } from '../tiers'
import { tierOf } from '../nightly/select'
import {
  DEFAULT_MATCH_TAB, MATCHES_ORDER, MATCHES_PAGE_SIZE, MATCH_TABS, afterCursor, decodeCursor, emptyState, encodeCursor,
  matchesQuery, mergePage, partyBand, splitPage, sumCounts, type MatchTab,
} from '../matchesList'

// Brief 48 (PR 12, item 4.4): the Matches screen's tabs, paging and empty
// state, as pure functions. The tabs follow lib/matching/tiers.ts (HOT is 80 and
// up, WARM 65 and up) [planner's fix list, approved by Ryan 2026-10-19]; the old
// tabs were GOLD 90+ and STRONG 70+. The list pages past its first 200.

test('the tabs are HOT 80+, WARM 65+ and ALL, from tiers.ts; WARM stays the default', () => {
  assert.deepEqual(MATCH_TABS.map(t => [t.id, t.label, t.scoreMin]), [
    ['hot', 'HOT 80+', HOT_MIN_FIT], ['warm', 'WARM 65+', WARM_MIN_FIT], ['all', 'ALL', null],
  ])
  assert.equal(HOT_MIN_FIT, 80)
  assert.equal(WARM_MIN_FIT, 65)
  assert.equal(DEFAULT_MATCH_TAB, 'warm')
  // Every HOT-tier score is in the HOT tab, every WARM-tier score is in the WARM tab and none below it.
  for (let score = 0; score <= 100; score++) {
    const inTab = (id: MatchTab) => score >= (MATCH_TABS.find(t => t.id === id)!.scoreMin ?? 0)
    assert.equal(inTab('hot'), tierOf(score) === 'HOT', `score ${score}`)
    assert.equal(inTab('warm'), tierOf(score) !== 'POSSIBLE', `score ${score}`)
  }
})

test("the Parties view counts Hot and Warm by the same thresholds as the cards' tiers", () => {
  for (let score = 0; score <= 100; score++) assert.equal(partyBand(score), tierOf(score).toLowerCase(), `score ${score}`)
  assert.deepEqual([79, 80, 64, 65, 89, 90].map(partyBand), ['warm', 'hot', 'possible', 'warm', 'hot', 'hot'])
})

test('the query for a tab, the seen switch and a page', () => {
  assert.equal(matchesQuery({ tab: 'hot', unseenOnly: true }), 'unseen=1&scoreMin=80')
  assert.equal(matchesQuery({ tab: 'warm', unseenOnly: false }), 'scoreMin=65')
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
    '0.91.-5.m', '0.91.1e3.m', '0. 91.1792487877123.m']) {
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

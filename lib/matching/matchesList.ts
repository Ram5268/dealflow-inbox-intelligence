import type { Prisma } from '@prisma/client'
import { HOT_MIN_FIT, WARM_MIN_FIT } from './tiers'

// Brief 48 (PR 12, item 4.4): the Matches screen's tabs, paging and empty-state
// words, shared by app/matches/page.tsx and GET /api/matches. Pure, so it's
// unit-tested without a browser or a database.

// ── Tabs ────────────────────────────────────────────────────────────────────
// The tabs follow the stored tiers (lib/matching/tiers.ts): HOT is 80 and up,
// WARM 65 and up [planner's fix list, approved by Ryan 2026-10-19]. Like the old
// GOLD 90+ / STRONG 70+ tabs, each is a score floor, so WARM 65+ includes HOT.
export type MatchTab = 'hot' | 'warm' | 'all'
export interface MatchTabDef { id: MatchTab; label: string; scoreMin: number | null }
export const MATCH_TABS: readonly MatchTabDef[] = [
  { id: 'hot',  label: `HOT ${HOT_MIN_FIT}+`,   scoreMin: HOT_MIN_FIT },
  { id: 'warm', label: `WARM ${WARM_MIN_FIT}+`, scoreMin: WARM_MIN_FIT },
  { id: 'all',  label: 'ALL',                   scoreMin: null },
]
// The second tab, as before (it was STRONG 70+).
export const DEFAULT_MATCH_TAB: MatchTab = 'warm'

// The Parties view's "N Hot · N Warm · N Poss" counts, by the same thresholds
// (they were 90 and 70, like the old tabs). From the score, since rows from the
// old matchers carry no tier.
export function partyBand(score: number): 'hot' | 'warm' | 'possible' {
  return score >= HOT_MIN_FIT ? 'hot' : score >= WARM_MIN_FIT ? 'warm' : 'possible'
}

const tabDef = (tab: MatchTab) => MATCH_TABS.find(t => t.id === tab) ?? MATCH_TABS[MATCH_TABS.length - 1]

// The list's query string: the seen switch, the tab's floor, and the page to start after.
export function matchesQuery({ tab, unseenOnly, cursor }: { tab: MatchTab; unseenOnly: boolean; cursor?: string | null }): string {
  const params = new URLSearchParams()
  if (unseenOnly) params.set('unseen', '1')
  const { scoreMin } = tabDef(tab)
  if (scoreMin !== null) params.set('scoreMin', String(scoreMin))
  if (cursor) params.set('after', cursor)
  return params.toString()
}

// ── Paging ──────────────────────────────────────────────────────────────────
// 200 a page, as the list's old cap. The order is unseen first, best score,
// newest, then id, so every row has one place. A page ends at a cursor: the
// last row's place in that order. The next page starts right after that place,
// whatever happened to the rows in between: a match opened (marked seen) since
// leaves the unseen list without pushing the next page along, which skipping a
// count of rows would. With seen matches shown, an opened match moves to the
// seen part and can come round again; mergePage shows it once.
export const MATCHES_PAGE_SIZE = 200
export const MATCHES_ORDER: Prisma.MatchOrderByWithRelationInput[] = [
  { seen: 'asc' }, { score: 'desc' }, { createdAt: 'desc' }, { id: 'asc' },
]

export type MatchCursor = { seen: boolean; score: number; createdAt: string; id: string }

// "<0|1>.<score>.<createdAt in ms>.<id>": plain text (no Buffer, so the page can
// import this module too). Times are stored to the millisecond, so ms is exact.
export function encodeCursor(row: { seen: boolean; score: number; createdAt: Date | string; id: string }): string {
  return [row.seen ? 1 : 0, row.score, new Date(row.createdAt).getTime(), row.id].join('.')
}

// null for a missing cursor or one that isn't ours.
export function decodeCursor(raw: string | null | undefined): MatchCursor | null {
  if (!raw) return null
  const [seen, score, ms, ...rest] = raw.split('.')
  const id = rest.join('.')
  const n = Number(score)
  const t = Number(ms)
  // Canonical integers only: String(Number(x)) === x refuses '', ' 7', '07', '1e3' and '1.5'.
  if ((seen !== '0' && seen !== '1') || String(n) !== score || !Number.isInteger(n) || String(t) !== ms || !Number.isInteger(t) || t < 0 || id === '') return null
  return { seen: seen === '1', score: n, createdAt: new Date(t).toISOString(), id }
}

// The rows after the cursor, in MATCHES_ORDER.
export function afterCursor(c: MatchCursor): Prisma.MatchWhereInput {
  const at = new Date(c.createdAt)
  return {
    OR: [
      ...(c.seen ? [] : [{ seen: true }]),
      { seen: c.seen, score: { lt: c.score } },
      { seen: c.seen, score: c.score, createdAt: { lt: at } },
      { seen: c.seen, score: c.score, createdAt: at, id: { gt: c.id } },
    ],
  }
}

// Rows read with take: size + 1 → the page, and the cursor for the next one (null when there's no more).
export function splitPage<T extends { seen: boolean; score: number; createdAt: Date | string; id: string }>(
  rows: T[], size = MATCHES_PAGE_SIZE,
): { page: T[]; nextCursor: string | null } {
  const page = rows.slice(0, size)
  return { page, nextCursor: rows.length > size && page.length > 0 ? encodeCursor(page[page.length - 1]) : null }
}

// The list on screen plus a new page: each match once, where it first appeared.
export function mergePage<T extends { id: string }>(shown: T[], next: T[]): T[] {
  const seenIds = new Set(shown.map(m => m.id))
  return [...shown, ...next.filter(m => !seenIds.has(m.id) && seenIds.add(m.id))]
}

export type MatchCounts = { total: number; unseen: number; mojo: number; listings: number; showings: number }
export const sumCounts = (a: MatchCounts, b: MatchCounts): MatchCounts => ({
  total: a.total + b.total, unseen: a.unseen + b.unseen, mojo: a.mojo + b.mojo, listings: a.listings + b.listings, showings: a.showings + b.showings,
})

// ── Empty state ─────────────────────────────────────────────────────────────
// Calm, plain English. The old text sent Ryan to Check In, which no longer makes
// matches: the nightly does, every morning (Brief 48 PR 1).
export function emptyState(view: 'matches' | 'parties', tab: MatchTab, unseenOnly: boolean): { title: string; hint: string } {
  const tier = tab === 'all' ? '' : `${tab.toUpperCase()} `
  const base = 'DealFlow looks for new matches every morning.'
  if (view === 'parties') {
    return {
      title: `No parties with ${unseenOnly ? 'new ' : ''}${tier}matches.`,
      hint: `${base} ${unseenOnly ? 'Tap Show seen to include the ones you have opened.' : 'Try another tab or filter.'}`,
    }
  }
  return {
    title: unseenOnly ? `No new ${tier}matches.` : `No ${tier}matches yet.`,
    hint: unseenOnly ? `${base} Tap Show seen to see the ones you have opened.` : tab === 'all' ? base : `${base} Try another tab.`,
  }
}

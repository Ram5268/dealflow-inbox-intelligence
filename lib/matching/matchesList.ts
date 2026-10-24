import type { Prisma } from '@prisma/client'
import { HOT_MIN_FIT, WARM_MIN_FIT } from './tiers'

// Brief 48 (PR 12, item 4.4): the Matches screen's tabs, paging and empty-state
// words, shared by app/matches/page.tsx and GET /api/matches. Pure, so it's
// unit-tested without a browser or a database.

// ── Tabs ────────────────────────────────────────────────────────────────────
// The tabs follow the tiers (lib/matching/tiers.ts): HOT is 80 and up, WARM 65
// to 79 [planner's fix list, approved by Ryan 2026-10-19; WARM as its own band:
// executor, 2026-10-23]. Each tab is one tier: the stored Match.tier (the
// nightly's tierOf), else the score for a row with no tier. That's the morning
// digest's rule (lib/push/digestCounts.ts) and Drift's (lib/chat/tools/
// countMatches.ts), so "5 Warm" in the digest is 5 cards under WARM.
export type MatchTab = 'hot' | 'warm' | 'all'
export type TabTier = 'HOT' | 'WARM'
export interface MatchTabDef { id: MatchTab; label: string; tier: TabTier | null }
export const MATCH_TABS: readonly MatchTabDef[] = [
  { id: 'hot',  label: `HOT ${HOT_MIN_FIT}+`,                    tier: 'HOT' },
  { id: 'warm', label: `WARM ${WARM_MIN_FIT}–${HOT_MIN_FIT - 1}`, tier: 'WARM' },
  { id: 'all',  label: 'ALL',                                    tier: null },
]
// The first tab, so the best matches show when the screen opens (WARM no longer
// includes them) [executor's call].
export const DEFAULT_MATCH_TAB: MatchTab = 'hot'

// One match's tier: the stored one, else by score (rows from the old matchers
// carry none). Same as lib/push/digestCounts.ts and lib/chat/sellerMatchesCard.ts.
export function matchTier(m: { tier: string | null; score: number }): 'HOT' | 'WARM' | 'POSSIBLE' {
  if (m.tier === 'HOT' || m.tier === 'WARM' || m.tier === 'POSSIBLE') return m.tier
  return m.score >= HOT_MIN_FIT ? 'HOT' : m.score >= WARM_MIN_FIT ? 'WARM' : 'POSSIBLE'
}

// The Parties view's "N Hot · N Warm · N Poss" counts, by the same rule (they
// were 90 and 70 on the score, like the old tabs).
export function partyBand(m: { tier: string | null; score: number }): 'hot' | 'warm' | 'possible' {
  return matchTier(m).toLowerCase() as 'hot' | 'warm' | 'possible'
}

// ?tier= on GET /api/matches and /api/matches/parties: 'hot' or 'warm'; anything
// else is no tier filter (ALL).
export function tierParam(raw: string | null | undefined): TabTier | null {
  const t = raw?.toUpperCase()
  return t === 'HOT' || t === 'WARM' ? t : null
}

// The rows in one tier, by matchTier's rule, as a Prisma where.
export function tierWhere(tier: TabTier): Prisma.MatchWhereInput {
  const byScore = tier === 'HOT' ? { gte: HOT_MIN_FIT } : { gte: WARM_MIN_FIT, lt: HOT_MIN_FIT }
  return { OR: [{ tier }, { tier: null, score: byScore }] }
}

const tabDef = (tab: MatchTab) => MATCH_TABS.find(t => t.id === tab) ?? MATCH_TABS[MATCH_TABS.length - 1]

// The list's query string: the seen switch, the tab's tier, and the page to start after.
export function matchesQuery({ tab, unseenOnly, cursor }: { tab: MatchTab; unseenOnly: boolean; cursor?: string | null }): string {
  const params = new URLSearchParams()
  if (unseenOnly) params.set('unseen', '1')
  const { tier } = tabDef(tab)
  if (tier) params.set('tier', tier.toLowerCase())
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

// The latest time a JavaScript Date can hold; past it, toISOString throws.
const MAX_TIME_MS = 8.64e15

// null for a missing cursor or one that isn't ours.
export function decodeCursor(raw: string | null | undefined): MatchCursor | null {
  if (!raw) return null
  const [seen, score, ms, ...rest] = raw.split('.')
  const id = rest.join('.')
  const n = Number(score)
  const t = Number(ms)
  // Canonical integers only: String(Number(x)) === x refuses '', ' 7', '07', '1e3' and '1.5'.
  if ((seen !== '0' && seen !== '1') || String(n) !== score || !Number.isInteger(n) || String(t) !== ms || !Number.isInteger(t) || t < 0 || t > MAX_TIME_MS || id === '') return null
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
// The counts line for some rows (a page, or the rows a page added to the screen).
export const countsOf = (rows: Array<{ seen: boolean; counterpartType: string }>): MatchCounts => ({
  total:    rows.length,
  unseen:   rows.filter(m => !m.seen).length,
  mojo:     rows.filter(m => m.counterpartType === 'mojo').length,
  listings: rows.filter(m => m.counterpartType === 'opportunity').length,
  showings: rows.filter(m => m.counterpartType === 'showing_confirmation').length,
})
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

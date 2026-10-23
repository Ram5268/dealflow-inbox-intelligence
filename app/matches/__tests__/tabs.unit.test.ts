import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Brief 48 (PR 12, item 4.4): the Matches page takes its tabs, its paging and its
// empty-state words from lib/matching/matchesList.ts (unit-tested there), not
// from numbers of its own. The old tabs were GOLD 90+ / STRONG 70+, against
// stored tiers of HOT 80+ / WARM 65+ (lib/matching/tiers.ts).
const page = readFileSync(join(__dirname, '..', 'page.tsx'), 'utf8')

test('the page uses the shared tabs, paging and empty state', () => {
  assert.match(page, /from '@\/lib\/matching\/matchesList'/)
  for (const name of ['MATCH_TABS', 'matchesQuery', 'mergePage', 'emptyState']) assert.ok(page.includes(name), name)
  assert.ok(!/GOLD 90|STRONG 70|scoreMin: (90|70)\b/.test(page), 'no tab numbers of its own')
  assert.ok(!/run a Check In/.test(page), 'the empty state no longer sends Ryan to Check In')
})

// Brief 48 (PR 12, review r1): the list's loading edge cases.
const body = (name: string) => {
  const start = page.indexOf(`async function ${name}(`)
  assert.ok(start >= 0, name)
  return page.slice(start, page.indexOf('\n  }\n', start))
}

test('a failed first page is an error, and a tab switch stops a pending "show more"', () => {
  const first = body('fetchMatches')
  assert.match(first, /if \(!r\.ok\) throw/)
  assert.match(first, /setLoadingMore\(false\)/)
})

test('"show more" counts only the cards it adds, and only its own tab clears its spinner', () => {
  const more = body('fetchMoreMatches')
  assert.match(more, /countsOf\(matches\.slice\(d\.matches\.length\)\)/)
  assert.ok(!/sumCounts\(d\.counts, j\.counts\)/.test(more), 'never adds the whole page\'s counts')
  assert.match(more, /finally \{\s*if \(seq === listSeq\.current\) setLoadingMore\(false\)\s*\}/)
})

test('a first page of only dismissed pairs still offers "show more" instead of the empty state', () => {
  assert.match(page, /data\.matches\.length === 0 && !nextCursor\) \? \(\s*<EmptyState/)
})

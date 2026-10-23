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

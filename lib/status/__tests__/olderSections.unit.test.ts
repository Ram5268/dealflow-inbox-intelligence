// Brief 48 (PR 16, Revision 1): the pure parts of the status page's older sections.
// "Last sync" is only the CRM copy and the background sync; a phone notification
// counts as delivered only when it reached at least one device; the Health page's
// "Recent activity" rows show times and counts only. Every row is invented.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BACKGROUND_SYNC, LAST_SYNC_ACTIONS, deliveredCount, recentActivityRows } from '../olderSections'
import { CRM_LEAD_SYNC } from '../lastNight'

test('"last sync" means the CRM copy or the background sync, nothing else', () => {
  assert.deepEqual([...LAST_SYNC_ACTIONS].sort(), [BACKGROUND_SYNC, CRM_LEAD_SYNC].sort())
  assert.equal(BACKGROUND_SYNC, 'BACKGROUND_SYNC') // as lib/backgroundSync.ts writes it
})

test('deliveredCount: pushes that reached at least one device', () => {
  assert.equal(deliveredCount([]), 0)
  assert.equal(deliveredCount([
    { detailsJson: { kind: 'digest', delivered: 2 } },
    { detailsJson: { kind: 'realtime', delivered: 1 } },
    { detailsJson: { kind: 'digest', delivered: 0 } }, // reached none
    { detailsJson: { kind: 'test' } }, // not recorded
    { detailsJson: { delivered: '3' } }, // not a number
    { detailsJson: null },
    { detailsJson: [1, 2] },
  ]), 2)
})

test('recentActivityRows: labels, times and counts; unknown shows a dash', () => {
  const rows = recentActivityRows({
    recentMatches: { newestAt: '2026-10-23T13:00:00.000Z', last24h: 4, last7d: 9 },
    recentPush: { newestAt: '2026-10-23T12:00:00.000Z', last24h: 1, last7d: 3, last7dDelivered: 2 },
    recentDismissals: { newestAt: null, last24h: 0, last7d: 0 },
  })
  assert.deepEqual(rows, [
    { label: 'Matches', newestAt: '2026-10-23T13:00:00.000Z', last24h: '4', last7d: '9' },
    { label: 'Phone notifications', newestAt: '2026-10-23T12:00:00.000Z', last24h: '1', last7d: '3 (2 reached a device)' },
    { label: 'Dismissed matches', newestAt: null, last24h: '0', last7d: '0' },
  ])
  // A block whose read failed is null; its row shows dashes rather than breaking the page.
  const failed = recentActivityRows({
    recentMatches: { newestAt: null, last24h: null, last7d: null },
    recentPush: { newestAt: null, last24h: null, last7d: null, last7dDelivered: null },
    recentDismissals: null,
  })
  assert.deepEqual(failed.map(r => [r.last24h, r.last7d]), [['—', '—'], ['—', '—'], ['—', '—']])
})

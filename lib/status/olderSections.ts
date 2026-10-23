// Brief 48 (PR 16, Revision 1): the status page's older sections (GET /api/debug/health:
// lastSync, recentMatches, recentDismissals, recentPush). Brief 47's report found they
// still listed match, party and listing ids, and that "last sync" took the newest
// AuditLog row with "SYNC" anywhere in its action name. Now they show counts and times
// only [planner, Brief 48 Revision 1; engineering precaution: the page is public], and
// "last sync" is only the CRM copy or the background sync [planner, Brief 48 Revision 1].
//
// No imports: the Health page (a client component) uses recentActivityRows from here.
// Importing lib/status/lastNight.ts put a browser copy of Node's crypto (through
// lib/config/maintenance.ts) in the page's script, about 500 KB instead of 5 KB
// [engineering precaution]. olderSections.unit.test.ts pins CRM_LEAD_SYNC to lastNight.ts's.

// lib/crm-sync/runSync.ts writes this after each CRM copy (the nightly's first step).
const CRM_LEAD_SYNC = 'CRM_LEAD_SYNC'
// lib/backgroundSync.ts writes this after each Outlook sync (Check In; paused with Outlook).
export const BACKGROUND_SYNC = 'BACKGROUND_SYNC'
// "Last sync": the nightly CRM copy (lib/crm-sync/runSync.ts) or the background sync.
export const LAST_SYNC_ACTIONS: readonly string[] = [CRM_LEAD_SYNC, BACKGROUND_SYNC]

// One older section: when the newest row was, and how many in the last 24 hours and 7 days.
// null: that read failed (the page shows a dash).
export type Recent = { newestAt: string | null; last24h: number | null; last7d: number | null }
export type RecentPush = Recent & { last7dDelivered: number | null }
export const UNKNOWN_RECENT: Recent = { newestAt: null, last24h: null, last7d: null }
export const UNKNOWN_RECENT_PUSH: RecentPush = { ...UNKNOWN_RECENT, last7dDelivered: null }

// PUSH_SENT rows (app/api/push/digest, app/api/push/test, lib/push/hotAlert.ts) record
// `delivered`, the number of devices reached. A row counts when that is a number above 0;
// a test push whose send never finished has none, so it doesn't count.
export function deliveredCount(rows: Array<{ detailsJson: unknown }>): number {
  return rows.filter(r => {
    const d = r.detailsJson
    if (typeof d !== 'object' || d === null || Array.isArray(d)) return false
    const n = (d as Record<string, unknown>).delivered
    return typeof n === 'number' && n > 0
  }).length
}

// The Health page's "Recent activity" table: one row per older section. The page formats
// newestAt itself (its fmt()); counts are text here so a failed read shows a dash.
export type ActivityRow = { label: string; newestAt: string | null; last24h: string; last7d: string }
const n = (v: number | null | undefined) => (typeof v === 'number' ? String(v) : '—')

export function recentActivityRows(d: {
  recentMatches: Recent | null
  recentPush: RecentPush | null
  recentDismissals: Recent | null
}): ActivityRow[] {
  const m = d.recentMatches ?? UNKNOWN_RECENT
  const p = d.recentPush ?? UNKNOWN_RECENT_PUSH
  const x = d.recentDismissals ?? UNKNOWN_RECENT
  const pushWeek = typeof p.last7d === 'number' && p.last7d > 0 && typeof p.last7dDelivered === 'number'
    ? `${p.last7d} (${p.last7dDelivered} reached a device)`
    : n(p.last7d)
  return [
    { label: 'Matches', newestAt: m.newestAt, last24h: n(m.last24h), last7d: n(m.last7d) },
    { label: 'Phone notifications', newestAt: p.newestAt, last24h: n(p.last24h), last7d: pushWeek },
    { label: 'Dismissed matches', newestAt: x.newestAt, last24h: n(x.last24h), last7d: n(x.last7d) },
  ]
}

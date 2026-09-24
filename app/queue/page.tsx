// Brief 33 — minimal call-queue viewer (server component). Read-only: renders the
// ranked list. NO tap-to-dial / dispositions (Brief 34). Reachable by URL; nav
// entry integration is pending (see report — BottomNav is orphaned).
import TopNav from '@/components/TopNav'
import { getCurrentOrgId } from '@/lib/auth/orgContext'
import { getTodayQueue } from '@/lib/ranking/queueRead'

export const dynamic = 'force-dynamic'

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return `${days}d ago`
}

export default async function QueuePage() {
  const orgId = await getCurrentOrgId()
  const { generatedAt, entries } = await getTodayQueue(orgId, 50)

  return (
    <div style={{ padding: '0 16px 120px', color: '#fff' }}>
      <TopNav />

      <div style={{ padding: '8px 4px 16px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: '-0.01em' }}>Today&apos;s Call Queue</h1>
        <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', margin: '4px 0 0' }}>
          {generatedAt ? `Generated ${relativeTime(generatedAt)}` : 'Not yet generated'}
        </p>
      </div>

      {entries.length === 0 ? (
        <div className="df-card" style={{ padding: 24, textAlign: 'center', color: 'rgba(255,255,255,0.55)', fontSize: 14 }}>
          No queue yet. The nightly build runs at 5am ET — check back then, or trigger the cron.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {entries.map(e => (
            <div key={e.rank} className="df-card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'rgba(255,255,255,0.35)', minWidth: 26, textAlign: 'right' }}>
                {e.rank}.
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {e.contact.fullName}
                </p>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: 'rgba(255,255,255,0.5)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {e.reason}
                  {e.contact.phone ? ` · ${e.contact.phone}` : ''}
                </p>
              </div>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.4)', minWidth: 24, textAlign: 'right' }}>
                {e.priorityScore}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

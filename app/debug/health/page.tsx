'use client'
import { useEffect, useState } from 'react'

// Brief 8.0-lite Fix #4 — phone-friendly view of /api/debug/health. Pure
// instrumentation (green/red dots per subsystem), not a product surface. Fetches
// client-side; no auth. Brief 47 (PR 4): the retired Zapier "Recent ingest" list is
// gone, as the API no longer returns it.

interface Health {
  flags: Record<string, boolean>
  graphToken: { expiresAt: string | null; expiresInMinutes: number | null; status: string }
  lastSync: { at: string | null; opportunitiesCreated: number; matchesCreated: number }
  recentMatches: Array<{ id: string; score: number; tier: string | null; counterpartType: string; createdAt: string }>
  recentDismissals: Array<{ partyId: string; listingId: string; reason: string | null; createdAt: string }>
  recentPush: Array<{ title: string; body: string; deliveredAt: string; success: boolean | null }>
  subsystemLastSuccess: { matcher: string | null; extraction: string | null }
}

function Dot({ ok }: { ok: boolean | null }) {
  const color = ok === null ? 'bg-gray-400' : ok ? 'bg-green-500' : 'bg-red-500'
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />
}

function fmt(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// A subsystem is "healthy" if its last success is within 48h.
function fresh(iso: string | null): boolean | null {
  if (!iso) return null
  return Date.now() - new Date(iso).getTime() < 48 * 60 * 60 * 1000
}

export default function HealthPage() {
  const [data, setData] = useState<Health | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/debug/health')
      .then(r => r.json())
      .then(setData)
      .catch(e => setErr(String(e)))
  }, [])

  if (err) return <main className="max-w-lg mx-auto p-4 text-red-600">Error: {err}</main>
  if (!data) return <main className="max-w-lg mx-auto p-4 text-gray-500">Loading…</main>

  const tokenOk =
    data.graphToken.status === 'fresh' ? true :
    data.graphToken.status === 'unknown' ? null : false

  return (
    <main className="max-w-lg mx-auto p-4 space-y-6 text-sm">
      <h1 className="text-lg font-semibold">System Health</h1>

      <section>
        <h2 className="font-medium mb-2 text-gray-700">Flags</h2>
        <table className="w-full">
          <tbody>
            {Object.entries(data.flags).map(([k, v]) => (
              <tr key={k} className="border-b border-gray-100">
                <td className="py-1 font-mono text-xs">{k}</td>
                <td className="py-1 text-right">{String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="font-medium mb-2 text-gray-700">Subsystems</h2>
        <table className="w-full">
          <tbody>
            <tr className="border-b border-gray-100">
              <td className="py-1"><Dot ok={tokenOk} /> Graph token</td>
              <td className="py-1 text-right">{data.graphToken.status} ({data.graphToken.expiresInMinutes ?? '—'}m)</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1"><Dot ok={fresh(data.subsystemLastSuccess.matcher)} /> Matcher</td>
              <td className="py-1 text-right">{fmt(data.subsystemLastSuccess.matcher)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1"><Dot ok={fresh(data.subsystemLastSuccess.extraction)} /> Extraction</td>
              <td className="py-1 text-right">{fmt(data.subsystemLastSuccess.extraction)}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="font-medium mb-2 text-gray-700">Last 24h</h2>
        <table className="w-full">
          <tbody>
            <tr className="border-b border-gray-100">
              <td className="py-1">Last sync</td><td className="py-1 text-right">{fmt(data.lastSync.at)}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1">Opportunities created</td><td className="py-1 text-right">{data.lastSync.opportunitiesCreated}</td>
            </tr>
            <tr className="border-b border-gray-100">
              <td className="py-1">Matches created</td><td className="py-1 text-right">{data.lastSync.matchesCreated}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="font-medium mb-2 text-gray-700">Recent matches ({data.recentMatches.length})</h2>
        <table className="w-full text-xs">
          <tbody>
            {data.recentMatches.map(m => (
              <tr key={m.id} className="border-b border-gray-100">
                <td className="py-1">{m.tier ?? '—'} · {m.score} · {m.counterpartType}</td>
                <td className="py-1 text-right">{fmt(m.createdAt)}</td>
              </tr>
            ))}
            {data.recentMatches.length === 0 && <tr><td className="py-1 text-gray-400">none</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="font-medium mb-2 text-gray-700">Recent push ({data.recentPush.length})</h2>
        <table className="w-full text-xs">
          <tbody>
            {data.recentPush.map((p, i) => (
              <tr key={i} className="border-b border-gray-100">
                <td className="py-1"><Dot ok={p.success} /> {p.title} {p.body}</td>
                <td className="py-1 text-right">{fmt(p.deliveredAt)}</td>
              </tr>
            ))}
            {data.recentPush.length === 0 && <tr><td className="py-1 text-gray-400">none</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="font-medium mb-2 text-gray-700">Recent dismissals ({data.recentDismissals.length})</h2>
        <table className="w-full text-xs">
          <tbody>
            {data.recentDismissals.map((d, i) => (
              <tr key={i} className="border-b border-gray-100">
                <td className="py-1 font-mono">{d.reason ?? 'skip'}</td>
                <td className="py-1 text-right">{fmt(d.createdAt)}</td>
              </tr>
            ))}
            {data.recentDismissals.length === 0 && <tr><td className="py-1 text-gray-400">none</td></tr>}
          </tbody>
        </table>
      </section>
    </main>
  )
}

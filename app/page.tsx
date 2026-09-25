'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import ChatSurfaceShell from '@/components/ChatSurfaceShell'
import { showToast } from '@/components/Toast'

interface GreetData {
  overnightEmails: number
  overnightOpps: number
  lastSync: string | null
  newMatches?: number
  newShowingConfirmations?: number
  pendingReviewCount?: number
}

function greetWord(): string {
  const h = new Date().getHours()
  if (h >= 5 && h < 12) return 'morning'
  if (h >= 12 && h < 17) return 'afternoon'
  return 'evening'
}

function timePeriod(): string {
  const h = new Date().getHours()
  if (h >= 4  && h < 7)  return 'DAWN'
  if (h >= 7  && h < 12) return 'MORNING'
  if (h >= 12 && h < 17) return 'AFTERNOON'
  if (h >= 17 && h < 21) return 'EVENING'
  return 'NIGHT'
}

function eyebrowDate(): string {
  const d = new Date()
  const day = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false })
  return `${day} · ${time}`
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

interface CalToday {
  todayCount: number
  nextEvent: { subject: string; start: string; location: string | null } | null
}

// Brief 7.4 (Section D) — market signal
interface MarketPulse {
  neighborhoods: Array<{ name: string; heat: 'HOT' | 'WARM' | 'COLD'; newListings: number; newISOs: number }>
}
const HEAT_EMOJI: Record<MarketPulse['neighborhoods'][number]['heat'], string> = { HOT: '🔥', WARM: '🟡', COLD: '⚪' }

export default function GreetPage() {
  const router = useRouter()
  const [givenName, setGivenName] = useState<string | null>(null)
  const [data, setData] = useState<GreetData | null>(null)
  const [calData, setCalData] = useState<CalToday | null | undefined>(undefined)
  const [market, setMarket] = useState<MarketPulse | null>(null)
  const [syncing, setSyncing] = useState(false)

  useEffect(() => {
    fetch('/api/user/profile').then(r => r.json()).then(d => setGivenName(d.givenName ?? null)).catch(() => showToast("Couldn't load profile"))
    fetch('/api/user/greeting').then(r => r.json()).then(setData).catch(() => showToast("Couldn't load overnight summary"))
    fetch('/api/calendar/today').then(r => r.json()).then(setCalData).catch(() => { setCalData(null); showToast("Couldn't load calendar") })
    fetch('/api/market/pulse').then(r => r.json()).then(setMarket).catch(() => showToast("Couldn't load market pulse"))
  }, [])

  // Register service worker + subscribe to push notifications.
  // Gated behind the Check In gesture so Safari accepts the permission
  // request and we don't prompt users on cold-launch with no context.
  async function subscribeToPushIfNeeded() {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      navigator.serviceWorker.register('/sw.js').then(async reg => {
        const vapidRes = await fetch('/api/push/key')
        const { publicKey } = await vapidRes.json()
        if (!publicKey) return

        const existing = await reg.pushManager.getSubscription()
        if (existing) return // already subscribed

        const permission = await Notification.requestPermission()
        if (permission !== 'granted') return

        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: publicKey,
        })
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sub),
        })
      }).catch(() => {})
    }
  }

  async function handleCheckIn() {
    setSyncing(true)
    // Fire the inbox sync in background — don't block navigation. (Seller leads
    // sync nightly from the CRM; see /api/cron/nightly-pipeline.)
    fetch('/api/sync/run', { method: 'POST' }).catch(() => {})
    subscribeToPushIfNeeded().catch(() => {})
    // Small delay so user sees the button respond, then navigate
    await new Promise(r => setTimeout(r, 320))
    router.push('/chat?new=1')
  }

  const lastSyncTime = data?.lastSync ? formatTime(data.lastSync) : '—'
  const oppCount = data?.overnightOpps ?? 0

  const pulse = [
    {
      tag: 'OVERNIGHT',
      body: data
        ? <span><span style={{ color: '#fff', fontWeight: 400 }}>{data.overnightEmails}</span> emails since last night.</span>
        : <span style={{ color: 'rgba(255,255,255,0.35)' }}>Loading…</span>,
    },
    {
      tag: `NEW · ${lastSyncTime}`,
      body: data
        ? <span><span style={{ color: '#fff', fontWeight: 400 }}>{oppCount}</span> new {oppCount === 1 ? 'opportunity' : 'opportunities'} extracted.</span>
        : <span style={{ color: 'rgba(255,255,255,0.35)' }}>Loading…</span>,
    },
    {
      tag: 'CALENDAR',
      body: calData === undefined
        ? <span style={{ color: 'rgba(255,255,255,0.35)' }}>Loading…</span>
        : calData === null || calData.todayCount === 0
        ? <span style={{ color: 'rgba(255,255,255,0.55)' }}>Clear schedule today.</span>
        : <span>
            <span style={{ color: '#fff', fontWeight: 400 }}>{calData.todayCount}</span>
            {calData.todayCount === 1 ? ' event' : ' events'} today
            {calData.nextEvent && (
              <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                {' · next: '}
                {new Date(calData.nextEvent.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                {' — '}{calData.nextEvent.subject.length > 38 ? calData.nextEvent.subject.slice(0, 38) + '…' : calData.nextEvent.subject}
              </span>
            )}
          </span>,
    },
    {
      tag: 'MATCHES',
      body: !data
        ? <span style={{ color: 'rgba(255,255,255,0.35)' }}>Loading…</span>
        : (data.newMatches ?? 0) === 0 && (data.newShowingConfirmations ?? 0) === 0
        ? <span style={{ color: 'rgba(255,255,255,0.45)' }}>No new matches since last sync.</span>
        : <span>
            {(data.newMatches ?? 0) > 0 && (
              <span><span style={{ color: 'var(--sr-cream)', fontWeight: 400 }}>{data.newMatches}</span> new {(data.newMatches ?? 0) === 1 ? 'match' : 'matches'}</span>
            )}
            {(data.newMatches ?? 0) > 0 && (data.newShowingConfirmations ?? 0) > 0 && <span> · </span>}
            {(data.newShowingConfirmations ?? 0) > 0 && (
              <span><span style={{ color: '#7dd3a8', fontWeight: 400 }}>{data.newShowingConfirmations}</span> showing {(data.newShowingConfirmations ?? 0) === 1 ? 'confirmation' : 'confirmations'}</span>
            )}
            {' — '}
            <span
              onClick={() => router.push('/matches')}
              style={{ color: 'var(--sr-cream)', textDecoration: 'underline', cursor: 'pointer' }}
            >
              Review →
            </span>
          </span>,
    },
    {
      tag: 'MARKET',
      body: !market
        ? <span style={{ color: 'rgba(255,255,255,0.35)' }}>Loading…</span>
        : market.neighborhoods.length === 0
        ? <span style={{ color: 'rgba(255,255,255,0.45)' }}>No neighborhood activity in the last 7 days.</span>
        : <span
            onClick={() => router.push('/trends')}
            style={{ cursor: 'pointer' }}
          >
            {market.neighborhoods.map((n, i) => (
              <span key={n.name}>
                {i > 0 && <span style={{ color: 'rgba(255,255,255,0.35)' }}>{' · '}</span>}
                <span style={{ color: '#fff', fontWeight: 400 }}>{n.name}</span>
                {' '}{HEAT_EMOJI[n.heat]} {n.heat}
                <span style={{ color: 'rgba(255,255,255,0.55)' }}>
                  {' ('}{n.newListings} new{n.newISOs > 0 ? ` · ${n.newISOs} ISOs` : ''}{')'}
                </span>
              </span>
            ))}
            <span style={{ color: 'var(--sr-cream)', textDecoration: 'underline', marginLeft: 6 }}>Trends →</span>
          </span>,
    },
    ...(data?.pendingReviewCount && data.pendingReviewCount > 0 ? [{
      tag: 'REVIEW',
      body: <span>
        <span style={{ color: 'rgba(230,200,100,0.9)', fontWeight: 400 }}>{data.pendingReviewCount}</span>
        {' '}{data.pendingReviewCount === 1 ? 'extraction' : 'extractions'} flagged for review
        {' — '}
        <span
          onClick={() => router.push('/review')}
          style={{ color: 'rgba(230,200,100,0.85)', textDecoration: 'underline', cursor: 'pointer' }}
        >
          Review →
        </span>
      </span>,
    }] : []),
  ]

  return (
    <ChatSurfaceShell>
      <div
        className="sr-anim-up"
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          color: '#fff',
          padding: '0 28px 26px',
          minHeight: 0,
        }}
      >
        {/* Top-left indicator: opp count · time period */}
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.22em',
          color: 'rgba(255,255,255,0.45)',
          paddingTop: 4,
          paddingBottom: 2,
        }}>
          {data ? String(oppCount).padStart(2, '0') : '—'} · {timePeriod()}
        </div>

        {/* Content — vertically centered */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', paddingBottom: 24 }}>
          {/* Eyebrow date */}
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.22em',
            color: 'rgba(255,255,255,0.55)',
            marginBottom: 10,
          }}>
            {eyebrowDate()}
          </div>

          {/* Greeting */}
          <div style={{
            fontFamily: 'var(--font-display)',
            fontSize: 38,
            fontWeight: 300,
            letterSpacing: '-0.018em',
            lineHeight: 1.05,
            color: '#fff',
          }}>
            Good {greetWord()},<br />
            <span style={{ fontStyle: 'italic', color: 'rgba(255,255,255,0.85)' }}>
              {givenName ?? 'Ryan'}.
            </span>
          </div>

          {/* Context line */}
          <div style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 14,
            fontWeight: 300,
            lineHeight: 1.55,
            color: 'rgba(255,255,255,0.7)',
            marginTop: 14,
          }}>
            {data
              ? `${data.overnightEmails > 0 ? 'A few things' : 'Nothing major'} moved while you slept.`
              : 'Checking your inbox…'
            }
          </div>

          {/* Pulse rows */}
          <div style={{ marginTop: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {pulse.map((p, i) => (
              <div
                key={i}
                className="sr-anim-up"
                style={{ animationDelay: `${0.1 + i * 0.12}s`, display: 'flex', gap: 14, alignItems: 'flex-start' }}
              >
                <span style={{ width: 3, alignSelf: 'stretch', background: 'rgba(255,255,255,0.18)', borderRadius: 2, marginTop: 2, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.5)' }}>{p.tag}</div>
                  <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 300, lineHeight: 1.45, color: 'rgba(255,255,255,0.82)', marginTop: 3 }}>{p.body}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Check In CTA */}
        <div>
          <button
            onClick={handleCheckIn}
            disabled={syncing}
            style={{
              width: '100%',
              background: syncing ? 'rgba(255,255,255,0.85)' : '#fff',
              color: '#0a1f2a',
              border: 'none',
              borderRadius: 999,
              padding: '14px 0',
              fontFamily: 'var(--font-ui)',
              fontSize: 13.5,
              fontWeight: 500,
              letterSpacing: '-0.005em',
              cursor: syncing ? 'default' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              transition: 'background 0.2s',
            }}
          >
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: '#0a1f2a',
              animation: 'sr-pulse-dot 1.6s ease-in-out infinite',
              display: 'inline-block',
            }} />
            {syncing ? 'Syncing…' : 'Check In'}
          </button>

          <div style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 11,
            fontWeight: 300,
            color: 'rgba(255,255,255,0.35)',
            textAlign: 'center',
            marginTop: 10,
          }}>
            syncs your inbox + leads
          </div>
        </div>
      </div>

      <style>{`
        @keyframes sr-pulse-dot {
          0%, 100% { opacity: 0.35; }
          50%       { opacity: 1; }
        }
      `}</style>
    </ChatSurfaceShell>
  )
}

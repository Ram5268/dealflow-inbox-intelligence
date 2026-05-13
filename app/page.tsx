'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import ChatSurfaceShell from '@/components/ChatSurfaceShell'

interface GreetData {
  overnightEmails: number
  overnightOpps: number
  lastSync: string | null
}

function greetWord(): string {
  const h = new Date().getHours()
  if (h >= 5 && h < 12) return 'morning'
  if (h >= 12 && h < 17) return 'afternoon'
  return 'evening'
}

function eyebrowDate(): string {
  const d = new Date()
  const day = d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase()
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false })
  return `${day} · ${time}`
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

export default function GreetPage() {
  const router = useRouter()
  const [givenName, setGivenName] = useState<string | null>(null)
  const [data, setData] = useState<GreetData | null>(null)
  const [dotActive, setDotActive] = useState(false)

  useEffect(() => {
    fetch('/api/user/profile').then(r => r.json()).then(d => setGivenName(d.givenName ?? null)).catch(() => {})
    fetch('/api/user/greeting').then(r => r.json()).then(setData).catch(() => {})
  }, [])

  // Derive real pulse bodies from live data
  const lastSyncTime = data?.lastSync ? formatTime(data.lastSync) : '—'
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
        ? <span><span style={{ color: '#fff', fontWeight: 400 }}>{data.overnightOpps}</span> new {data.overnightOpps === 1 ? 'opportunity' : 'opportunities'} extracted.</span>
        : <span style={{ color: 'rgba(255,255,255,0.35)' }}>Loading…</span>,
    },
    {
      tag: 'CALENDAR',
      body: <span style={{ color: 'rgba(255,255,255,0.45)' }}>Not connected yet.</span>,
    },
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
        {/* Content — vertically centered */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          {/* Eyebrow date */}
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.22em',
              color: 'rgba(255,255,255,0.55)',
            }}
          >
            {eyebrowDate()}
          </div>

          {/* Greeting */}
          <div
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 34,
              fontWeight: 300,
              letterSpacing: '-0.018em',
              lineHeight: 1.05,
              marginTop: 14,
              color: '#fff',
            }}
          >
            Good {greetWord()},<br />
            <span style={{
              fontStyle: 'italic',
              color: 'rgba(255,255,255,0.85)',
            }}>
              {givenName ?? 'there'}.
            </span>
          </div>

          {/* Context */}
          <div
            style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 14,
              fontWeight: 300,
              lineHeight: 1.55,
              color: 'rgba(255,255,255,0.7)',
              marginTop: 18,
              maxWidth: 260,
            }}
          >
            {data
              ? `${data.overnightEmails > 0 ? 'A few things' : 'Nothing major'} moved while you slept.`
              : 'Checking your inbox…'
            }
          </div>

          {/* Pulse rows — left bar + text (not glass cards) */}
          <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 14 }}>
            {pulse.map((p, i) => (
              <div
                key={i}
                className="sr-anim-up"
                style={{
                  animationDelay: `${0.1 + i * 0.12}s`,
                  display: 'flex',
                  gap: 14,
                  alignItems: 'flex-start',
                }}
              >
                {/* Left accent bar */}
                <span style={{
                  width: 3,
                  alignSelf: 'stretch',
                  background: 'rgba(255,255,255,0.18)',
                  borderRadius: 2,
                  marginTop: 2,
                  flexShrink: 0,
                }} />
                <div style={{ flex: 1 }}>
                  <div style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    letterSpacing: '0.18em',
                    color: 'rgba(255,255,255,0.5)',
                  }}>
                    {p.tag}
                  </div>
                  <div style={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 13,
                    fontWeight: 300,
                    lineHeight: 1.45,
                    color: 'rgba(255,255,255,0.82)',
                    marginTop: 3,
                  }}>
                    {p.body}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <div>
          <button
            onClick={() => router.push('/chat?new=1')}
            style={{
              width: '100%',
              background: '#fff',
              color: '#0a1f2a',
              border: 'none',
              borderRadius: 999,
              padding: '14px 0',
              fontFamily: 'var(--font-ui)',
              fontSize: 13.5,
              fontWeight: 500,
              letterSpacing: '-0.005em',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
            }}
          >
            {/* Pulsing live dot */}
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: '#0a1f2a',
              animation: 'sr-pulse-dot 1.6s ease-in-out infinite',
              display: 'inline-block',
            }} />
            Pick up where we left off
          </button>

          <div style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 11,
            fontWeight: 300,
            color: 'rgba(255,255,255,0.45)',
            textAlign: 'center',
            marginTop: 10,
          }}>
            or just say what you need
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

'use client'

import { useEffect, useState } from 'react'
import { CATEGORY_LABELS } from '@/lib/utils'
import ChatSurfaceShell from '@/components/ChatSurfaceShell'

interface TrendsData {
  totalEmails: number
  totalOpps: number
  byCategory: { category: string; count: number }[]
  topBrokerages: { name: string; count: number }[]
  last7Days: number
  last7DaysOpps: number
}

function CategoryChart({ data }: { data: { category: string; count: number }[] }) {
  if (data.length === 0) return null
  const top = data.slice(0, 8)
  const maxCount = Math.max(...top.map(d => d.count), 1)
  const W = 300, H = 70
  const BAR_H = 6
  const GAP = (H - top.length * BAR_H) / (top.length + 1)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block' }}>
      <defs>
        <linearGradient id="bar-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#F2DFBD" stopOpacity="0.75" />
          <stop offset="1" stopColor="#F2DFBD" stopOpacity="0.15" />
        </linearGradient>
      </defs>
      {top.map((d, i) => {
        const barW = (d.count / maxCount) * (W - 4)
        const y = GAP + i * (BAR_H + GAP)
        return (
          <g key={d.category}>
            <rect x={0} y={y} width={W - 4} height={BAR_H} rx={3} fill="rgba(255,255,255,0.06)" />
            <rect x={0} y={y} width={barW} height={BAR_H} rx={3} fill="url(#bar-grad)" />
          </g>
        )
      })}
    </svg>
  )
}

export default function TrendsPage() {
  const [data, setData] = useState<TrendsData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/trends').then(r => r.json()).then(setData).finally(() => setLoading(false))
  }, [])

  const now = new Date()
  const eyebrow = `${now.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()} · ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })} · YOUR MARKETS`

  const topCat = data?.byCategory[0]
  const forYouText = topCat
    ? `Most active: ${CATEGORY_LABELS[topCat.category] ?? topCat.category} — ${topCat.count} opportunities extracted.`
    : null

  const movers = (data?.topBrokerages ?? []).slice(0, 5)

  return (
    <ChatSurfaceShell>
      <div
        className="sr-anim-up"
        style={{ flex: 1, overflowY: 'auto', padding: '12px 22px 32px', scrollbarWidth: 'none' as const, color: '#fff' }}
      >
        {loading ? (
          <div style={{ textAlign: 'center', paddingTop: 60, fontFamily: 'var(--font-ui)', fontSize: 13, color: 'rgba(255,255,255,0.3)' }}>Loading…</div>
        ) : !data ? (
          <div style={{ textAlign: 'center', paddingTop: 60, fontFamily: 'var(--font-ui)', fontSize: 13, color: 'rgba(255,255,255,0.4)' }}>No data yet — run a sync first.</div>
        ) : (
          <>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.22em', color: 'rgba(255,255,255,0.55)' }}>{eyebrow}</div>

            <div style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 300, letterSpacing: '-0.018em', lineHeight: 1.05, marginTop: 8 }}>
              Trends, <span style={{ fontStyle: 'italic', color: 'rgba(255,255,255,0.75)' }}>your markets.</span>
            </div>

            <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 300, color: 'rgba(255,255,255,0.65)', marginTop: 8, lineHeight: 1.5 }}>
              {data.last7DaysOpps} new opportunities in the last 7 days across{' '}
              <span style={{ color: '#fff' }}>{data.byCategory.length} categories</span>. {data.last7Days} emails synced.
            </div>

            {/* Category chart */}
            <div style={{ marginTop: 18, padding: '14px 16px 10px', borderRadius: 18, background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.14)', backdropFilter: 'blur(28px) saturate(170%)', WebkitBackdropFilter: 'blur(28px) saturate(170%)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 16px 30px rgba(0,0,0,0.35)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.18em', color: 'var(--sr-cream)' }}>DEAL CATEGORIES · ALL TIME</span>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 400 }}>
                  {data.totalOpps} <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--sr-cream)' }}>total</span>
                </span>
              </div>
              <CategoryChart data={data.byCategory} />
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {data.byCategory.slice(0, 6).map(c => (
                  <div key={c.category} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: 300, color: 'rgba(255,255,255,0.6)' }}>{CATEGORY_LABELS[c.category] ?? c.category}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>{c.count}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Movers — top brokerages */}
            {movers.length > 0 && (
              <>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.22em', color: 'rgba(255,255,255,0.55)', marginTop: 22, marginBottom: 8 }}>TOP BROKERAGES</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {movers.map((m, i) => (
                    <div key={m.name} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, alignItems: 'center', padding: '10px 14px', borderRadius: 12, background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.14)', backdropFilter: 'blur(28px) saturate(170%)', WebkitBackdropFilter: 'blur(28px) saturate(170%)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 16px 30px rgba(0,0,0,0.35)' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.18em', color: 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name.toUpperCase()}</div>
                        <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, fontWeight: 300, color: 'rgba(255,255,255,0.55)', marginTop: 2 }}>listings in inbox</div>
                      </div>
                      <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 400, letterSpacing: '-0.005em' }}>{m.count}</div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: i === 0 ? 'var(--sr-cream)' : 'rgba(255,255,255,0.4)', minWidth: 28, textAlign: 'right' }}>
                        {i === 0 ? '↗' : '—'}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* FOR YOU */}
            {forYouText && (
              <div style={{ marginTop: 18, padding: '14px 16px', borderRadius: 14, background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.14)', backdropFilter: 'blur(28px) saturate(170%)', WebkitBackdropFilter: 'blur(28px) saturate(170%)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18), 0 16px 30px rgba(0,0,0,0.35)' }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.18em', color: 'var(--sr-cream)' }}>FOR YOU</div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 400, letterSpacing: '-0.005em', marginTop: 6, lineHeight: 1.3, fontStyle: 'italic' }}>{forYouText}</div>
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, fontWeight: 300, color: 'rgba(255,255,255,0.6)', marginTop: 6, lineHeight: 1.5 }}>
                  {data.totalEmails} emails processed total. Ask Drift to surface the best ones.
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </ChatSurfaceShell>
  )
}

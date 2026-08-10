'use client'

import type { ReactNode } from 'react'

// Brief 7.4 (Section B) — glass card summarizing one demand/lead party and its
// matches. Tap to expand → the parent renders that party's matches inline (reusing
// the exact match-card component). Matches the /matches card aesthetic.
interface Party {
  id: string
  name: string
  role: 'BUYER' | 'RENTER' | 'SELLER'
  source: 'inbox' | 'mojo'
  isSEExpert: boolean
  criteria: string
  matchCount: number
  tierBreakdown: { hot: number; warm: number; possible: number }
  topMatchId: string
}

const ROLE_TONE: Record<Party['role'], string> = {
  BUYER:  'rgba(130,200,230,0.9)',
  RENTER: 'rgba(150,220,180,0.9)',
  SELLER: 'rgba(230,140,80,0.95)',
}

export default function PartyCard({ party, expanded, onToggle, children }: {
  party: Party
  expanded: boolean
  onToggle: () => void
  children: ReactNode  // the party's match cards, rendered by the parent
}) {
  const tone = party.isSEExpert ? 'var(--sr-cream, #EAB308)' : ROLE_TONE[party.role]
  const tb = party.tierBreakdown
  const breakdown = [
    tb.hot > 0      ? `🔴 ${tb.hot} Hot` : null,
    tb.warm > 0     ? `🟡 ${tb.warm} Warm` : null,
    tb.possible > 0 ? `⚪ ${tb.possible} Poss` : null,
  ].filter(Boolean).join(' · ')

  return (
    <div
      onClick={onToggle}
      className="sr-anim-up"
      style={{
        borderRadius: 16,
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.1)',
        backdropFilter: 'blur(20px) saturate(160%)',
        WebkitBackdropFilter: 'blur(20px) saturate(160%)',
        padding: '12px 16px',
        cursor: 'pointer',
      }}
    >
      {/* Top row — mono, cream when SE Expert */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em' }}>
        <span style={{ color: tone }}>
          {party.isSEExpert ? '⭐ ' : ''}{party.role} · {party.name.toUpperCase()} · {party.matchCount} {party.matchCount === 1 ? 'MATCH' : 'MATCHES'}
        </span>
        <span style={{ color: 'rgba(255,255,255,0.4)' }}>{expanded ? '▾' : '→'}</span>
      </div>

      {/* Criteria line */}
      {party.criteria && (
        <div style={{ marginTop: 6, fontSize: 13, color: 'rgba(255,255,255,0.75)', lineHeight: 1.35 }}>
          {party.criteria}
        </div>
      )}

      {/* Tier breakdown */}
      {breakdown && (
        <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em', color: 'rgba(255,255,255,0.55)' }}>
          {breakdown}
        </div>
      )}

      {party.source === 'mojo' && (
        <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.14em', color: 'rgba(230,140,80,0.8)' }}>
          🔥 MOJO LEAD
        </div>
      )}

      {expanded && (
        <div
          onClick={e => e.stopPropagation()}
          style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          {children}
        </div>
      )}
    </div>
  )
}

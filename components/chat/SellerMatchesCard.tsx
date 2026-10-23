'use client'

import type { SellerMatchesCard } from '@/lib/chat/sellerMatchesCard'
import { matchesHeadline, matchesTitle, shownNote, tierTone } from './sellerMatchesView'

// Brief 43 PR 6 (N1; D11 [Ryan, 2026-10-18]): the buyers DealFlow matched to the
// one CRM seller Ryan asked about. The seller's name and neighborhood, the count
// by tier, then each buyer best first: HOT, WARM or POSSIBLE, the score, what
// they want, why it fits, a "Test buyer" badge on test data, and "Open in
// Matches", which opens that exact match on /matches (Brief 38) in a new tab so
// the chat stays put. No buyer's name, phone or email. Same dark glass language
// as the seller card.
export default function SellerMatchesCards({ cards }: { cards: SellerMatchesCard[] }) {
  if (cards.length === 0) return null
  return (
    <>
      {cards.map(card => {
        const note = shownNote(card)
        return (
          <div
            key={card.seller.id}
            data-testid="seller-matches-card"
            style={{
              width: '100%', maxWidth: 360, marginTop: 10,
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.16)',
              borderRadius: 16, padding: '14px 16px',
              display: 'flex', flexDirection: 'column', gap: 4,
              backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 14.5, fontWeight: 600, color: '#fff', lineHeight: 1.25 }}>{matchesTitle(card)}</span>
              {card.seller.doNotContact && (
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: '#FCA5A5', border: '1px solid rgba(252,165,165,0.55)', background: 'rgba(239,68,68,0.14)',
                  borderRadius: 999, padding: '2px 8px',
                }}>
                  Do not contact
                </span>
              )}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.6)', letterSpacing: '0.04em' }}>{matchesHeadline(card)}</div>

            {card.buyers.map(b => (
              <div
                key={b.matchId}
                data-testid="seller-match-buyer"
                style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.10)', display: 'flex', flexDirection: 'column', gap: 3 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', color: tierTone(b.tier) }}>{b.tier}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>Match {b.score}</span>
                  {b.isTestData && (
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.06em',
                      color: 'rgba(255,255,255,0.6)', border: '1px solid rgba(255,255,255,0.22)', borderRadius: 999, padding: '1px 7px',
                    }}>
                      Test buyer
                    </span>
                  )}
                </div>
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'rgba(255,255,255,0.9)', lineHeight: 1.35 }}>{b.wants}</div>
                <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 300, color: 'rgba(255,255,255,0.6)', lineHeight: 1.35 }}>{b.fit}</div>
                <a
                  href={b.matchesUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ alignSelf: 'flex-start', marginTop: 2, display: 'inline-flex', alignItems: 'center', gap: 6, textDecoration: 'none' }}
                >
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 500, color: '#fff', letterSpacing: '0.06em' }}>Open in Matches</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(120,200,220,0.9)' }}>↗</span>
                </a>
              </div>
            ))}

            {note && (
              <div style={{ marginTop: 8, fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 300, color: 'rgba(255,255,255,0.5)' }}>{note}</div>
            )}
          </div>
        )
      })}
    </>
  )
}

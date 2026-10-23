'use client'

import type { SellerCard } from '@/lib/chat/sellerCard'
import { sellerAddressLine } from './sellerCardView'

// Brief 43 PR 5 (D11 [Ryan, 2026-10-18]): the one CRM seller Ryan asked for,
// by name or by address. Name, phone as plain text (no tel: link: nothing is
// dialed from Drift [Ryan, 2026-09-24]), address, and an "Open in CRM" button
// that opens the lead in a new tab, so Ryan looks them up in the CRM himself.
// An opted-out homeowner carries a "Do not contact" badge. Same dark glass
// language as the report preview card.
export default function SellerCards({ cards }: { cards: SellerCard[] }) {
  if (cards.length === 0) return null
  return (
    <>
      {cards.map(card => {
        const addressLine = sellerAddressLine(card)
        return (
          <div
            key={card.id}
            data-testid="seller-card"
            style={{
              width: '100%', maxWidth: 360, marginTop: 10,
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.16)',
              borderRadius: 16, padding: '14px 16px',
              display: 'flex', flexDirection: 'column', gap: 4,
              backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 14.5, fontWeight: 600, color: '#fff', lineHeight: 1.25 }}>{card.name}</span>
              {card.doNotContact && (
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
                  color: '#FCA5A5', border: '1px solid rgba(252,165,165,0.55)', background: 'rgba(239,68,68,0.14)',
                  borderRadius: 999, padding: '2px 8px',
                }}>
                  Do not contact
                </span>
              )}
            </div>
            {card.phone && (
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'rgba(255,255,255,0.85)', letterSpacing: '0.02em' }}>{card.phone}</div>
            )}
            {addressLine && (
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 300, color: 'rgba(255,255,255,0.6)' }}>{addressLine}</div>
            )}
            {card.crmUrl && (
              <a
                href={card.crmUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  alignSelf: 'flex-start', marginTop: 8,
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  padding: '8px 14px', borderRadius: 22,
                  background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)',
                  textDecoration: 'none',
                }}
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 500, color: '#fff', letterSpacing: '0.06em' }}>Open in CRM</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(120,200,220,0.9)' }}>↗</span>
              </a>
            )}
          </div>
        )
      })}
    </>
  )
}

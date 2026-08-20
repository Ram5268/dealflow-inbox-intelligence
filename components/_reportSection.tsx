'use client'

import type { ReportSectionContent, ReportSourceRef } from '@/lib/reports/uiTypes'

// Brief 28.0 — shared structured-content renderers for a report section, used by
// both FragmentBlock (inline in chat) and ReportModal (full-screen). Item/metric
// shapes are the buyer-match generator's (address / priceLabel / fit|why|expected
// / etc.) with a generic fallback so future templates render sensibly.

function str(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v || null
  if (typeof v === 'number') return String(v)
  return null
}

export function SectionItems({ items }: { items: NonNullable<ReportSectionContent['items']> }) {
  if (!items.length) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      {items.map((it, i) => {
        const title = str(it.address) ?? str(it.listingId) ?? str(it.title) ?? ''
        const price = str(it.priceLabel) ?? str(it.price) ?? ''
        const detail = str(it.fit) ?? str(it.why) ?? str(it.expected) ?? ''
        const hood = str(it.neighborhood)
        const beds = str(it.bedsLabel)
        const meta = [hood, beds].filter(Boolean).join(' · ')
        return (
          <div key={i} style={{
            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)',
            borderRadius: 12, padding: '10px 12px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 600, color: '#fff' }}>{title || `Item ${i + 1}`}</span>
              {price && <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.85)', flexShrink: 0 }}>{price}</span>}
            </div>
            {meta && <div style={{ fontFamily: 'var(--font-ui)', fontSize: 11.5, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{meta}</div>}
            {detail && <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 300, color: 'rgba(255,255,255,0.65)', lineHeight: 1.4, marginTop: 4 }}>{detail}</div>}
          </div>
        )
      })}
    </div>
  )
}

export function SectionMetrics({ metrics }: { metrics: NonNullable<ReportSectionContent['metrics']> }) {
  if (!metrics.length) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginTop: 8 }}>
      {metrics.map((m, i) => (
        <div key={i} style={{
          display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline',
          padding: '7px 0', borderBottom: i < metrics.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
        }}>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, color: 'rgba(255,255,255,0.55)' }}>{m.label}</span>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 500, color: 'rgba(255,255,255,0.9)', textAlign: 'right' }}>{m.value}</span>
        </div>
      ))}
    </div>
  )
}

export function SourceChips({ sources }: { sources: ReportSourceRef[] }) {
  if (!sources.length) return null
  const types = [...new Set(sources.map(s => s.type))]
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
      {types.map(t => (
        <span key={t} style={{
          fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '0.08em',
          color: 'rgba(255,255,255,0.4)', background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)', borderRadius: 999, padding: '2px 8px',
        }}>{t.toUpperCase()}</span>
      ))}
    </div>
  )
}

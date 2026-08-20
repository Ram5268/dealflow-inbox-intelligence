'use client'

import { useEffect, useState } from 'react'
import { showToast } from './Toast'
import { SectionItems, SectionMetrics, SourceChips } from './_reportSection'
import type { ReportSectionResult } from '@/lib/reports/uiTypes'

// Brief 28.0 — full-screen report viewer with Copy. Fetches GET /api/reports/:id
// on open, renders each section (numbered heading, prose, items, metrics, source
// chips). Copy writes the pre-rendered markdown to the clipboard. Full-screen (not
// a sheet): close via × or system back. Body-scroll locked while open.

type FullReport = {
  id: string
  templateName: string
  subject?: string
  markdown: string
  sections: ReportSectionResult[]
}

export default function ReportModal({ reportId, onClose }: { reportId: string | null; onClose: () => void }) {
  const [report, setReport] = useState<FullReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!reportId) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [reportId])

  useEffect(() => {
    if (!reportId) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reportId, onClose])

  useEffect(() => {
    if (!reportId) { setReport(null); return }
    let alive = true
    setLoading(true); setError(null); setReport(null)
    fetch(`/api/reports/${reportId}`)
      .then(r => r.json())
      .then(d => { if (!alive) return; if (d.error) setError(d.error); else setReport(d as FullReport) })
      .catch(() => { if (alive) setError('Could not load the report.') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [reportId])

  async function copy() {
    if (!report?.markdown) return
    try { await navigator.clipboard.writeText(report.markdown); showToast('Copied') }
    catch { showToast('Copy failed') }
  }

  if (!reportId) return null

  return (
    <div role="dialog" aria-modal="true" aria-label="Report"
      style={{
        position: 'fixed', inset: 0, zIndex: 300,
        background: 'rgba(12,15,20,0.96)',
        backdropFilter: 'blur(30px)', WebkitBackdropFilter: 'blur(30px)',
        display: 'flex', flexDirection: 'column',
        paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
        borderBottom: '1px solid rgba(255,255,255,0.1)', flexShrink: 0,
      }}>
        <button onClick={onClose} aria-label="Close" style={iconBtn}>×</button>
        <div style={{ flex: 1, textAlign: 'center', minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {report?.templateName ?? 'Report'}
          </div>
        </div>
        <button onClick={copy} disabled={!report} aria-label="Copy report"
          style={{
            ...iconBtn, width: 'auto', padding: '0 14px', borderRadius: 999, fontSize: 13,
            fontFamily: 'var(--font-ui)', fontWeight: 500, gap: 6,
            opacity: report ? 1 : 0.4, color: 'var(--sr-cream, #f5e9d4)',
          }}>
          ⧉ Copy
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px 40px', WebkitOverflowScrolling: 'touch' }}>
        {loading ? (
          <ModalSkeleton />
        ) : error ? (
          <div style={{ fontSize: 14, color: 'rgba(240,140,140,0.9)', padding: '20px 0' }}>{error}</div>
        ) : report ? (
          <div style={{ maxWidth: 640, margin: '0 auto' }}>
            {report.subject && (
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'rgba(255,255,255,0.6)', marginBottom: 20 }}>{report.subject}</div>
            )}
            {report.sections.map((s, i) => (
              <div key={s.key} style={{ marginBottom: 26 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 6 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>{String(i + 1).padStart(2, '0')}</span>
                  <span style={{ fontFamily: 'var(--font-ui)', fontSize: 16, fontWeight: 600, color: '#fff' }}>{s.title}</span>
                </div>
                {s.content.prose && (
                  <p style={{ fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 300, lineHeight: 1.55, color: 'rgba(255,255,255,0.82)', margin: 0 }}>{s.content.prose}</p>
                )}
                {s.content.items && s.content.items.length > 0 && <SectionItems items={s.content.items} />}
                {s.content.metrics && s.content.metrics.length > 0 && <SectionMetrics metrics={s.content.metrics} />}
                <SourceChips sources={s.sources} />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

const iconBtn: React.CSSProperties = {
  minWidth: 40, height: 40, borderRadius: '50%', background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.8)',
  fontSize: 22, lineHeight: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
}

function ModalSkeleton() {
  return (
    <div style={{ maxWidth: 640, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 22 }}>
      {[0, 1, 2, 3].map(i => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ ...shimmer, height: 18, width: '45%' }} />
          <div style={{ ...shimmer, height: 46, width: '100%' }} />
        </div>
      ))}
      <style>{`@keyframes sr-shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }`}</style>
    </div>
  )
}

const shimmer: React.CSSProperties = {
  borderRadius: 10,
  background: 'linear-gradient(100deg, rgba(255,255,255,0.04) 30%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.04) 70%)',
  backgroundSize: '200% 100%', animation: 'sr-shimmer 1.4s linear infinite',
}

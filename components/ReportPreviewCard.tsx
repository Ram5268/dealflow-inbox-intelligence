'use client'

import type { AttachedReport } from '@/lib/reports/uiTypes'

// Brief 28.0 — in-chat preview card for a generated full report. Tapping it opens
// the ReportModal. Matches the dark glass card language of the chat thread (the
// seFilterUrl button / deal chips), not the light opportunity-list cards.

export default function ReportPreviewCard({ attachedReport, onTap }: { attachedReport: AttachedReport; onTap: () => void }) {
  const { templateName, subject, sectionCount, matchCount } = attachedReport
  const summaryBits = [`${sectionCount} section${sectionCount === 1 ? '' : 's'}`]
  if (typeof matchCount === 'number') summaryBits.push(`${matchCount} hot match${matchCount === 1 ? '' : 'es'}`)

  return (
    <button
      onClick={onTap}
      aria-label={`Open ${templateName}`}
      style={{
        textAlign: 'left', width: '100%', maxWidth: 360,
        marginTop: 10,
        background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.16)',
        borderRadius: 16, padding: '14px 16px',
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 4,
        backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ fontSize: 16, lineHeight: 1.2 }}>📄</span>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 14.5, fontWeight: 600, color: '#fff', flex: 1, lineHeight: 1.25 }}>{templateName}</span>
      </div>
      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 300, color: 'rgba(255,255,255,0.6)', paddingLeft: 24 }}>{subject}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 24, marginTop: 3 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.06em', color: 'rgba(255,255,255,0.45)' }}>
          {summaryBits.join(' · ').toUpperCase()}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '0.06em', color: 'var(--sr-cream, #EAB308)' }}>TAP TO VIEW ↗</span>
      </div>
    </button>
  )
}

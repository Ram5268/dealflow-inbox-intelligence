'use client'

import { useEffect, useRef, useState } from 'react'
import { REPORT_TEMPLATES, type ReportTemplate } from '@/lib/reports/templates'

// Brief 28.0 — report picker (Phase 1b). Two screens in one sheet: the template
// list and, for a tapped template, a detail view. Tapping Generate in the
// detail view calls onGenerate(templateId); the parent (chat page) then opens
// the buyer picker. Glass-sheet chrome + drag-to-dismiss + body-scroll lock
// reuse the DraftOutreachSheet pattern (Brief 7.3/23).
// Brief 48 PR 19 [Ryan 1.11]: the 20 locked templates are gone, so the list is
// the reports that can be made (today the Buyer Match report), with no
// discipline tabs and no locked cards. Listing only templates that can be made
// is an engineering precaution.

interface Props {
  open: boolean
  onClose: () => void
  onGenerate: (templateId: string) => void
}

const LABEL_MONO: React.CSSProperties = {
  fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.14em',
  color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase',
}

export default function ReportPickerSheet({ open, onClose, onGenerate }: Props) {
  const [entered, setEntered] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dragOffsetY, setDragOffsetY] = useState(0)
  const [dragging, setDragging] = useState(false)
  const dragStartY = useRef(0)

  // Reset to the list whenever the sheet re-opens.
  useEffect(() => {
    if (open) setSelectedId(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  useEffect(() => {
    if (!open) { setEntered(false); return }
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (selectedId) setSelectedId(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, selectedId, onClose])

  function onHandleTouchStart(e: React.TouchEvent) { dragStartY.current = e.touches[0].clientY; setDragging(true) }
  function onHandleTouchMove(e: React.TouchEvent) { const dy = e.touches[0].clientY - dragStartY.current; if (dy > 0) setDragOffsetY(dy) }
  function onHandleTouchEnd() {
    setDragging(false)
    if (dragOffsetY >= Math.min(80, window.innerHeight * 0.2)) onClose()
    setDragOffsetY(0)
  }

  if (!open) return null

  const visible = REPORT_TEMPLATES.filter(t => t.isUnlocked)
  const selected = selectedId ? visible.find(t => t.id === selectedId) ?? null : null

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', justifyContent: 'center', alignItems: 'flex-end' }}
    >
      <div aria-hidden style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)', opacity: entered ? 1 : 0, transition: 'opacity 200ms ease' }} />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Generate report"
        onClick={e => e.stopPropagation()}
        style={{
          position: 'relative', width: '100%', maxWidth: 512, height: '88vh',
          background: 'rgba(20,24,30,0.72)',
          backdropFilter: 'blur(28px) saturate(160%)', WebkitBackdropFilter: 'blur(28px) saturate(160%)',
          borderTop: '1px solid rgba(255,255,255,0.12)',
          borderTopLeftRadius: 22, borderTopRightRadius: 22,
          boxShadow: '0 -12px 40px rgba(0,0,0,0.4)',
          transform: entered ? `translateY(${dragOffsetY}px)` : 'translateY(100%)',
          transition: dragging ? 'none' : 'transform 300ms cubic-bezier(0.4, 0.2, 0.2, 1)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {selected ? (
          <TemplateDetail template={selected} onBack={() => setSelectedId(null)} onGenerate={() => onGenerate(selected.id)} />
        ) : (
          <>
            {/* Drag handle */}
            <div onTouchStart={onHandleTouchStart} onTouchMove={onHandleTouchMove} onTouchEnd={onHandleTouchEnd}
              style={{ display: 'flex', justifyContent: 'center', paddingTop: 8, paddingBottom: 8, touchAction: 'none', cursor: 'grab' }}>
              <div style={{ width: 36, height: 4, borderRadius: 999, background: 'rgba(255,255,255,0.3)' }} />
            </div>

            {/* Sticky header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px 10px' }}>
              <span style={LABEL_MONO}>📄 Generate Report</span>
              <button onClick={onClose} aria-label="Close" style={closeBtn}>×</button>
            </div>

            {/* Template list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '0 18px calc(20px + env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {visible.map(t => (
                <TemplateCard key={t.id} template={t} onTap={() => setSelectedId(t.id)} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const closeBtn: React.CSSProperties = {
  width: 32, height: 32, borderRadius: '50%', background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.7)',
  fontSize: 20, lineHeight: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
}

function TemplateCard({ template: t, onTap }: { template: ReportTemplate; onTap: () => void }) {
  return (
    <button
      onClick={onTap}
      style={{
        textAlign: 'left', width: '100%',
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 16, padding: '13px 15px',
        cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.08em', color: 'rgba(255,255,255,0.45)' }}>{t.code}</span>
        <span style={{ fontFamily: 'var(--font-ui)', fontSize: 15, fontWeight: 600, color: '#fff', flex: 1 }}>{t.name}</span>
      </div>
      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>For: {t.forWhom}</div>
      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 300, color: 'rgba(255,255,255,0.7)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
        {t.purpose}
      </div>
    </button>
  )
}

function TemplateDetail({ template: t, onBack, onGenerate }: { template: ReportTemplate; onBack: () => void; onGenerate: () => void }) {
  return (
    <>
      {/* Header with back */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px 10px', flexShrink: 0 }}>
        <button onClick={onBack} aria-label="Back" style={{ ...closeBtn, fontSize: 18 }}>‹</button>
        <span style={LABEL_MONO}>{t.code} · {t.disciplineName}</span>
      </div>

      {/* Scrollable body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 18px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={{ fontFamily: 'var(--font-ui)', fontSize: 22, fontWeight: 600, color: '#fff', lineHeight: 1.2 }}>{t.name}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            <Chip text={`For: ${t.forWhom}`} />
            <Chip text={`Cadence: ${t.cadence}`} />
          </div>
        </div>

        <Section label="PURPOSE">
          <p style={proseStyle}>{t.purpose}</p>
        </Section>

        <Section label="SECTIONS">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {t.sections.map((s, i) => (
              <div key={s.key} style={{ display: 'flex', gap: 10 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'rgba(255,255,255,0.4)', paddingTop: 1 }}>{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <div style={{ fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 500, color: 'rgba(255,255,255,0.9)' }}>{s.title}</div>
                  <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 300, color: 'rgba(255,255,255,0.55)', lineHeight: 1.4, marginTop: 2 }}>{s.description}</div>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section label="NUMBERS">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {t.metrics.map(m => <Chip key={m} text={m} />)}
          </div>
        </Section>

        <div style={{
          background: 'rgba(234,179,8,0.10)', border: '1px solid rgba(234,179,8,0.3)',
          borderRadius: 12, padding: '12px 14px',
        }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'rgba(234,179,8,0.9)', marginBottom: 5 }}>⚠ WATCH</div>
          <p style={{ ...proseStyle, color: 'rgba(255,255,255,0.8)' }}>{t.watch}</p>
        </div>
      </div>

      {/* Sticky CTA */}
      <div style={{ padding: '10px 18px calc(18px + env(safe-area-inset-bottom))', flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
        <button onClick={onGenerate} style={{
          width: '100%', background: 'var(--sr-cream, #f5e9d4)', border: 'none', borderRadius: 14,
          padding: '15px 0', fontFamily: 'var(--font-ui)', fontSize: 15, fontWeight: 600, color: '#0a1f2a', cursor: 'pointer',
        }}>
          Generate Report →
        </button>
      </div>
    </>
  )
}

const proseStyle: React.CSSProperties = {
  fontFamily: 'var(--font-ui)', fontSize: 13.5, fontWeight: 300, lineHeight: 1.5,
  color: 'rgba(255,255,255,0.75)', margin: 0,
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ ...LABEL_MONO, fontSize: 10, marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  )
}

function Chip({ text }: { text: string }) {
  return (
    <span style={{
      padding: '5px 10px', borderRadius: 999, background: 'rgba(255,255,255,0.06)',
      border: '1px solid rgba(255,255,255,0.12)', fontFamily: 'var(--font-ui)', fontSize: 11.5,
      color: 'rgba(255,255,255,0.7)',
    }}>{text}</span>
  )
}

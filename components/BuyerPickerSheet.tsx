'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

// Brief 28.0 — buyer picker for M-02. Fetches BUYER_ISO / RENTER_INQUIRY
// opportunities from /api/reports/available-buyers with persisted-Match counts,
// client-side searchable. Tapping a buyer dismisses the sheet and hands the id
// up for report generation. Same glass-sheet chrome as ReportPickerSheet.

type Buyer = {
  id: string
  displayName: string
  criteriaSummary: string
  matchCount: { hot: number; warm: number; near: number }
  updatedAt: string
}

interface Props {
  open: boolean
  onClose: () => void
  onBack?: () => void
  onPick: (buyerId: string, displayName: string) => void
}

const LABEL_MONO: React.CSSProperties = {
  fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.14em',
  color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase',
}

export default function BuyerPickerSheet({ open, onClose, onBack, onPick }: Props) {
  const [entered, setEntered] = useState(false)
  const [buyers, setBuyers] = useState<Buyer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [dragOffsetY, setDragOffsetY] = useState(0)
  const [dragging, setDragging] = useState(false)
  const dragStartY = useRef(0)
  const fetchedRef = useRef(false)

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

  // Fetch once per open.
  useEffect(() => {
    if (!open) { fetchedRef.current = false; setQuery(''); return }
    if (fetchedRef.current) return
    fetchedRef.current = true
    setLoading(true); setError(null)
    fetch('/api/reports/available-buyers')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.buyers)) setBuyers(d.buyers); else setError('Could not load buyers.') })
      .catch(() => setError('Could not load buyers.'))
      .finally(() => setLoading(false))
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  function onHandleTouchStart(e: React.TouchEvent) { dragStartY.current = e.touches[0].clientY; setDragging(true) }
  function onHandleTouchMove(e: React.TouchEvent) { const dy = e.touches[0].clientY - dragStartY.current; if (dy > 0) setDragOffsetY(dy) }
  function onHandleTouchEnd() {
    setDragging(false)
    if (dragOffsetY >= Math.min(80, window.innerHeight * 0.2)) onClose()
    setDragOffsetY(0)
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return buyers
    return buyers.filter(b => b.displayName.toLowerCase().includes(q) || b.criteriaSummary.toLowerCase().includes(q))
  }, [buyers, query])

  if (!open) return null

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 210, display: 'flex', justifyContent: 'center', alignItems: 'flex-end' }}>
      <div aria-hidden style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)', opacity: entered ? 1 : 0, transition: 'opacity 200ms ease' }} />

      <div role="dialog" aria-modal="true" aria-label="Pick a buyer" onClick={e => e.stopPropagation()}
        style={{
          position: 'relative', width: '100%', maxWidth: 512, height: '85vh',
          background: 'rgba(20,24,30,0.72)',
          backdropFilter: 'blur(28px) saturate(160%)', WebkitBackdropFilter: 'blur(28px) saturate(160%)',
          borderTop: '1px solid rgba(255,255,255,0.12)', borderTopLeftRadius: 22, borderTopRightRadius: 22,
          boxShadow: '0 -12px 40px rgba(0,0,0,0.4)',
          transform: entered ? `translateY(${dragOffsetY}px)` : 'translateY(100%)',
          transition: dragging ? 'none' : 'transform 300ms cubic-bezier(0.4, 0.2, 0.2, 1)',
          display: 'flex', flexDirection: 'column',
        }}>
        {/* Drag handle */}
        <div onTouchStart={onHandleTouchStart} onTouchMove={onHandleTouchMove} onTouchEnd={onHandleTouchEnd}
          style={{ display: 'flex', justifyContent: 'center', paddingTop: 8, paddingBottom: 8, touchAction: 'none', cursor: 'grab' }}>
          <div style={{ width: 36, height: 4, borderRadius: 999, background: 'rgba(255,255,255,0.3)' }} />
        </div>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 18px 10px' }}>
          {onBack && <button onClick={onBack} aria-label="Back" style={{ ...iconBtn, fontSize: 18 }}>‹</button>}
          <span style={{ ...LABEL_MONO, flex: 1 }}>👤 Pick a buyer</span>
          <button onClick={onClose} aria-label="Close" style={iconBtn}>×</button>
        </div>

        {/* Search */}
        <div style={{ padding: '0 18px 12px' }}>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by name or criteria…"
            style={{
              width: '100%', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 12, padding: '12px 14px', color: '#fff', fontFamily: 'var(--font-ui)', fontSize: 16, outline: 'none',
            }}
          />
        </div>

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 18px calc(20px + env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {loading ? (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em', color: 'var(--sr-cream, #EAB308)', padding: '10px 2px' }}>⏳ LOADING BUYERS…</div>
          ) : error ? (
            <div style={{ fontSize: 13, color: 'rgba(240,140,140,0.9)', padding: '10px 2px' }}>{error}</div>
          ) : filtered.length === 0 ? (
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', padding: '10px 2px' }}>{query ? 'No buyers match that search.' : 'No buyer ISOs on file.'}</div>
          ) : (
            filtered.map(b => <BuyerRow key={b.id} buyer={b} onTap={() => onPick(b.id, b.displayName)} />)
          )}
        </div>
      </div>
    </div>
  )
}

const iconBtn: React.CSSProperties = {
  width: 32, height: 32, borderRadius: '50%', background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.7)',
  fontSize: 20, lineHeight: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
}

function BuyerRow({ buyer: b, onTap }: { buyer: Buyer; onTap: () => void }) {
  const hot = b.matchCount.hot
  const near = b.matchCount.warm + b.matchCount.near
  return (
    <button onClick={onTap} style={{
      textAlign: 'left', width: '100%', background: 'rgba(255,255,255,0.05)',
      border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14, padding: '13px 15px',
      cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 5, minHeight: 44,
    }}>
      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 15, fontWeight: 600, color: '#fff' }}>{b.displayName}</div>
      <div style={{ fontFamily: 'var(--font-ui)', fontSize: 12.5, fontWeight: 300, color: 'rgba(255,255,255,0.55)' }}>{b.criteriaSummary}</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
        {hot > 0 && <Badge text={`${hot} hot`} tone="hot" />}
        {near > 0 && <Badge text={`${near} near-miss${near === 1 ? '' : 'es'}`} tone="near" />}
        {hot === 0 && near === 0 && <Badge text="no matches yet" tone="muted" />}
      </div>
    </button>
  )
}

function Badge({ text, tone }: { text: string; tone: 'hot' | 'near' | 'muted' }) {
  const color = tone === 'hot' ? 'rgba(120,220,150,0.95)' : tone === 'near' ? 'rgba(234,179,8,0.9)' : 'rgba(255,255,255,0.4)'
  const bg = tone === 'hot' ? 'rgba(120,220,150,0.12)' : tone === 'near' ? 'rgba(234,179,8,0.12)' : 'rgba(255,255,255,0.05)'
  return (
    <span style={{
      padding: '3px 9px', borderRadius: 999, background: bg, color,
      fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.04em',
    }}>{text}</span>
  )
}

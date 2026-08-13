'use client'

import { useEffect, useRef, useState } from 'react'

// Brief 7.3 — confirm sheet for the ONLY action that writes to Microsoft 365.
// Styling mirrors DismissReasonSheet (glass bottom sheet, slide-up, backdrop dim).
// The safety footnote is required: this is the one place email-adjacent read-only
// posture is broken, and only on the user's explicit tap.
interface Props {
  matchId: string
  address: string          // read-only summary line
  partyName: string
  open: boolean
  onClose: () => void
  onScheduled: (message: string) => void  // parent shows a toast
}

const DURATIONS = [15, 30, 45, 60] as const

// Default: tomorrow at 2:00 PM local, formatted for a datetime-local input
// ("YYYY-MM-DDTHH:mm"). Naive local — the server pairs it with America/New_York.
function defaultStart(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(14, 0, 0, 0)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function CalendarConfirmSheet({ matchId, address, partyName, open, onClose, onScheduled }: Props) {
  const [entered, setEntered] = useState(false)
  const [start, setStart] = useState(defaultStart)
  const [duration, setDuration] = useState<number>(30)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submittingRef = useRef(false)

  // Lock body scroll while open so the page behind the sheet can't scroll on
  // iPhone PWA. Capture the previous value so a nested modal restores correctly.
  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [open])

  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  async function submit() {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/matches/${matchId}/schedule-showing`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ start, durationMinutes: duration }),
      })
      if (res.ok) {
        onScheduled('Added to calendar')
        return
      }
      const j = await res.json().catch(() => ({})) as { error?: string }
      setError(res.status === 409 ? 'Calendar writes are off in test mode.' : (j.error ?? 'Could not add to calendar.'))
    } catch {
      setError('Could not add to calendar.')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', justifyContent: 'center', alignItems: 'flex-end' }}
    >
      <div aria-hidden style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)', opacity: entered ? 1 : 0, transition: 'opacity 200ms ease' }} />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add showing to calendar"
        onClick={e => e.stopPropagation()}
        style={{
          position: 'relative', width: '100%', maxWidth: 512,
          background: 'rgba(20,24,30,0.72)',
          backdropFilter: 'blur(28px) saturate(160%)', WebkitBackdropFilter: 'blur(28px) saturate(160%)',
          borderTop: '1px solid rgba(255,255,255,0.12)',
          borderTopLeftRadius: 22, borderTopRightRadius: 22,
          boxShadow: '0 -12px 40px rgba(0,0,0,0.4)',
          padding: '10px 18px calc(24px + env(safe-area-inset-bottom))',
          transform: entered ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform 300ms cubic-bezier(0.4, 0.2, 0.2, 1)',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 2 }}>
          <div style={{ width: 36, height: 4, borderRadius: 999, background: 'rgba(255,255,255,0.3)' }} />
        </div>

        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase' }}>
          Add showing to calendar?
        </div>

        {/* Read-only summary */}
        <div style={{ fontSize: 14, color: '#fff', lineHeight: 1.4 }}>
          {address}
          {partyName && <span style={{ color: 'rgba(255,255,255,0.55)' }}>{' w/ '}{partyName}</span>}
        </div>

        {/* Date/time */}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.45)' }}>WHEN</span>
          <input
            type="datetime-local"
            value={start}
            onChange={e => setStart(e.target.value)}
            style={{
              background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 12, padding: '12px 14px', color: '#fff',
              fontFamily: 'var(--font-ui)', fontSize: 14, colorScheme: 'dark',
            }}
          />
        </label>

        {/* Duration segmented control */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.45)' }}>DURATION</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {DURATIONS.map(d => {
              const active = duration === d
              return (
                <button
                  key={d}
                  onClick={() => setDuration(d)}
                  style={{
                    flex: 1,
                    background: active ? 'var(--sr-cream, #f5e9d4)' : 'rgba(255,255,255,0.06)',
                    border: `1px solid ${active ? 'transparent' : 'rgba(255,255,255,0.12)'}`,
                    borderRadius: 12, padding: '10px 0',
                    fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '0.06em',
                    color: active ? '#0a1f2a' : 'rgba(255,255,255,0.75)',
                    fontWeight: active ? 600 : 400, cursor: 'pointer', transition: 'background 160ms, color 160ms',
                  }}
                >
                  {d}m
                </button>
              )
            })}
          </div>
        </div>

        {error && <div style={{ fontSize: 12, color: 'rgba(240,140,140,0.9)' }}>{error}</div>}

        {/* Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 2 }}>
          <button
            disabled={submitting}
            onClick={submit}
            style={{
              background: 'var(--sr-cream, #f5e9d4)', border: 'none', borderRadius: 14,
              padding: '14px 0', fontFamily: 'var(--font-ui)', fontSize: 15, fontWeight: 600,
              color: '#0a1f2a', cursor: submitting ? 'default' : 'pointer', opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? 'Adding…' : '✓ Add to calendar'}
          </button>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'rgba(255,255,255,0.4)' }}
          >
            Cancel
          </button>
        </div>

        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.4)', textAlign: 'center', lineHeight: 1.5 }}>
          ⓘ This is the only action that writes to your Microsoft 365.
        </div>
      </div>
    </div>
  )
}

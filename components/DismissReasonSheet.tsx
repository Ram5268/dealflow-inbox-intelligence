'use client'

import { useEffect, useRef, useState } from 'react'

// Brief 7.1 — bottom sheet for dismissing a match with an optional reason.
// Reason values MUST match the Prisma DismissalReason enum (WRONG_PRICE,
// WRONG_NEIGHBORHOOD, WRONG_TIMING, GHOSTED, OTHER). The reason is forward-
// looking: a future brief can auto-re-surface a match when its reason no longer
// applies (e.g. a WRONG_PRICE dismissal clears on a price drop). "Skip reason"
// dismisses with reason: null. WRONG_TIMING has no button today (no natural
// UI label in Ryan's mock) — deliberately unmapped, not a bug.
interface Props {
  matchId: string
  open: boolean
  onClose: () => void
  onDismissed: (matchId: string) => void  // parent removes card from list
}

type ReasonValue = 'WRONG_NEIGHBORHOOD' | 'WRONG_PRICE' | 'GHOSTED' | 'OTHER'

const REASONS: Array<{ emoji: string; label: string; value: ReasonValue }> = [
  { emoji: '🚫', label: 'Not the right prop.', value: 'WRONG_NEIGHBORHOOD' },
  { emoji: '💰', label: 'Wrong price',         value: 'WRONG_PRICE' },
  { emoji: '👀', label: 'Client already saw',  value: 'GHOSTED' },
  { emoji: '🤷', label: 'Just not interested', value: 'OTHER' },
]

export default function DismissReasonSheet({ matchId, open, onClose, onDismissed }: Props) {
  const [submitting, setSubmitting] = useState(false)
  // Mount-then-animate so the slide-up transition runs on open.
  const [entered, setEntered] = useState(false)
  const submittingRef = useRef(false)

  // Lock body scroll while open so the page behind the sheet can't scroll on
  // iPhone PWA. Capture the previous value so a nested modal restores correctly.
  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [open])

  // Mount-then-animate: schedule setEntered in a rAF (async, not a synchronous
  // effect-body setState) so the slide-up transition runs. The parent mounts this
  // only while open, so a fresh mount already starts with entered=false.
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

  async function submit(reason: ReasonValue | null) {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      const res = await fetch(`/api/matches/${matchId}/dismiss`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ reason }),
      })
      // 200 = dismissed, 409 = already dismissed — both mean "hide it".
      if (res.ok || res.status === 409) {
        onDismissed(matchId)
      } else {
        console.warn('[matches] dismiss failed', res.status)
        submittingRef.current = false
        setSubmitting(false)
      }
    } catch (e) {
      console.warn('[matches] dismiss error', e)
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        display: 'flex', justifyContent: 'center', alignItems: 'flex-end',
      }}
    >
      {/* Backdrop */}
      <div
        aria-hidden
        style={{
          position: 'absolute', inset: 0,
          background: 'rgba(0,0,0,0.4)',
          opacity: entered ? 1 : 0,
          transition: 'opacity 200ms ease',
        }}
      />

      {/* Sheet */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Dismiss match"
        onClick={e => e.stopPropagation()}
        style={{
          position: 'relative',
          width: '100%', maxWidth: 512,
          background: 'rgba(20,24,30,0.72)',
          backdropFilter: 'blur(28px) saturate(160%)',
          WebkitBackdropFilter: 'blur(28px) saturate(160%)',
          borderTop: '1px solid rgba(255,255,255,0.12)',
          borderTopLeftRadius: 22, borderTopRightRadius: 22,
          boxShadow: '0 -12px 40px rgba(0,0,0,0.4)',
          padding: '10px 18px calc(28px + env(safe-area-inset-bottom))',
          transform: entered ? 'translateY(0)' : 'translateY(100%)',
          transition: 'transform 300ms cubic-bezier(0.4, 0.2, 0.2, 1)',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        {/* Drag handle */}
        <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 4 }}>
          <div style={{ width: 36, height: 4, borderRadius: 999, background: 'rgba(255,255,255,0.3)' }} />
        </div>

        <div style={{
          fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.14em',
          color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase',
        }}>
          Dismiss match?
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {REASONS.map(r => (
            <button
              key={r.value}
              disabled={submitting}
              onClick={() => submit(r.value)}
              style={{
                textAlign: 'left',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 14,
                padding: '13px 15px',
                fontFamily: 'var(--font-ui)', fontSize: 14,
                color: 'rgba(255,255,255,0.85)',
                cursor: submitting ? 'default' : 'pointer',
                opacity: submitting ? 0.5 : 1,
                transition: 'background 160ms',
              }}
            >
              <span style={{ marginRight: 10 }}>{r.emoji}</span>{r.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginTop: 4 }}>
          <button
            disabled={submitting}
            onClick={() => submit(null)}
            style={{
              background: 'transparent', border: 'none', cursor: submitting ? 'default' : 'pointer',
              fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--sr-cream)',
              opacity: submitting ? 0.5 : 1,
            }}
          >
            Skip reason
          </button>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              fontFamily: 'var(--font-ui)', fontSize: 13, color: 'rgba(255,255,255,0.4)',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

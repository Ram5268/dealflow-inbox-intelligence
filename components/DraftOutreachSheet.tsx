'use client'

import { useEffect, useRef, useState } from 'react'

// Brief 7.3 — one sheet for both outreach channels (channel: 'email' | 'text').
// Sonnet drafts the copy; the user edits, then hands it off to the NATIVE app via
// a mailto:/sms: link. Nothing sends from here — that's the whole safety posture.
type Channel = 'email' | 'text'

interface Props {
  matchId: string
  partyName: string
  channel: Channel
  open: boolean
  onClose: () => void
  onToast: (message: string) => void
}

interface DraftResponse {
  subject?: string
  body: string
  to: { name: string; email: string | null; phone: string | null }
}

export default function DraftOutreachSheet({ matchId, partyName, channel, open, onClose, onToast }: Props) {
  const [entered, setEntered] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [to, setTo] = useState<DraftResponse['to'] | null>(null)
  const fetchedRef = useRef(false)

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

  // Draft once per mount. Parent mounts this fresh each open, so the ref resets.
  useEffect(() => {
    if (!open || fetchedRef.current) return
    fetchedRef.current = true
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/matches/${matchId}/draft-outreach`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ channel }),
        })
        if (!res.ok) {
          const j = await res.json().catch(() => ({})) as { error?: string }
          setError(res.status === 429 ? 'Daily draft budget reached — try again tomorrow.' : (j.error ?? 'Could not draft.'))
          return
        }
        const j = await res.json() as DraftResponse
        setSubject(j.subject ?? '')
        setBody(j.body ?? '')
        setTo(j.to)
      } catch {
        setError('Could not draft.')
      } finally {
        setLoading(false)
      }
    })()
  }, [open, matchId, channel])

  if (!open) return null

  const recipient = channel === 'email' ? to?.email : to?.phone
  const hasRecipient = !!recipient

  function openNativeApp() {
    if (channel === 'email') {
      const url = `mailto:${to?.email ?? ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
      window.location.href = url
    } else {
      const url = `sms:${to?.phone ?? ''}?&body=${encodeURIComponent(body)}`
      window.location.href = url
    }
  }

  async function copy() {
    const text = channel === 'email' && subject ? `${subject}\n\n${body}` : body
    try {
      await navigator.clipboard.writeText(text)
      onToast('Copied')
    } catch {
      onToast('Copy failed')
    }
  }

  const missingLabel = channel === 'email'
    ? 'No email on file — use Copy instead.'
    : 'No phone on file — use Copy.'
  const primaryLabel = channel === 'email' ? '📧 Open in Mail' : '📱 Open in Messages'
  const bodyLines = channel === 'email' ? 8 : 4

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex', justifyContent: 'center', alignItems: 'flex-end' }}
    >
      <div aria-hidden style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)', opacity: entered ? 1 : 0, transition: 'opacity 200ms ease' }} />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Draft ${channel}`}
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
          display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 2 }}>
          <div style={{ width: 36, height: 4, borderRadius: 999, background: 'rgba(255,255,255,0.3)' }} />
        </div>

        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase' }}>
          ✍️ Draft {channel} to {partyName}
        </div>

        {error ? (
          <div style={{ fontSize: 13, color: 'rgba(240,140,140,0.9)', padding: '12px 0' }}>{error}</div>
        ) : loading ? (
          <DraftingSkeleton lines={bodyLines} withSubject={channel === 'email'} />
        ) : (
          <>
            {channel === 'email' && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.45)' }}>SUBJECT</span>
                <input
                  value={subject}
                  onChange={e => setSubject(e.target.value)}
                  style={{
                    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 12, padding: '11px 13px', color: '#fff', fontFamily: 'var(--font-ui)', fontSize: 14,
                  }}
                />
              </label>
            )}

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.45)' }}>MESSAGE</span>
              <textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                rows={bodyLines}
                style={{
                  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 12, padding: '11px 13px', color: '#fff', fontFamily: 'var(--font-ui)',
                  fontSize: 14, lineHeight: 1.5, resize: 'vertical',
                }}
              />
            </label>

            {!hasRecipient && (
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>{missingLabel}</div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 2 }}>
              <button
                disabled={!hasRecipient}
                onClick={openNativeApp}
                style={{
                  background: hasRecipient ? 'var(--sr-cream, #f5e9d4)' : 'rgba(255,255,255,0.06)',
                  border: hasRecipient ? 'none' : '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 14, padding: '14px 0', fontFamily: 'var(--font-ui)', fontSize: 15, fontWeight: 600,
                  color: hasRecipient ? '#0a1f2a' : 'rgba(255,255,255,0.4)',
                  cursor: hasRecipient ? 'pointer' : 'default',
                }}
              >
                {primaryLabel}
              </button>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  onClick={copy}
                  style={{
                    flex: 1, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 14, padding: '12px 0', fontFamily: 'var(--font-ui)', fontSize: 14,
                    color: 'rgba(255,255,255,0.85)', cursor: 'pointer',
                  }}
                >
                  📋 Copy
                </button>
                <button
                  onClick={onClose}
                  style={{
                    flex: 1, background: 'transparent', border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: 14, padding: '12px 0', fontFamily: 'var(--font-ui)', fontSize: 14,
                    color: 'rgba(255,255,255,0.4)', cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </>
        )}

        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.4)', textAlign: 'center', lineHeight: 1.5 }}>
          ⓘ DealFlow drafts. You send. Nothing leaves this app on its own.
        </div>
      </div>
    </div>
  )
}

// Skeleton shown while Sonnet drafts — same ticker aesthetic as the chat page.
function DraftingSkeleton({ lines, withSubject }: { lines: number; withSubject: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 0' }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.12em', color: 'var(--sr-cream, #EAB308)' }}>
        ⏳ Drafting…
      </div>
      {withSubject && <div style={{ height: 40, borderRadius: 12, background: 'rgba(255,255,255,0.06)' }} />}
      <div style={{
        height: lines * 22 + 20, borderRadius: 12,
        background: 'linear-gradient(100deg, rgba(255,255,255,0.04) 30%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.04) 70%)',
        backgroundSize: '200% 100%', animation: 'sr-shimmer 1.4s linear infinite',
      }} />
      <style>{`@keyframes sr-shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }`}</style>
    </div>
  )
}

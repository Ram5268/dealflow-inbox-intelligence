'use client'

import { useEffect, useState } from 'react'

type ToastMsg = { id: number; text: string }

let counter = 0
const listeners = new Set<(msg: ToastMsg) => void>()

export function showToast(text: string) {
  const msg = { id: ++counter, text }
  listeners.forEach(l => l(msg))
}

export default function Toast() {
  const [toasts, setToasts] = useState<ToastMsg[]>([])

  useEffect(() => {
    const listener = (msg: ToastMsg) => {
      setToasts(prev => [...prev, msg])
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== msg.id))
      }, 4000)
    }
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])

  if (toasts.length === 0) return null

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 'calc(24px + env(safe-area-inset-bottom))',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 500,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 'calc(100vw - 32px)',
        pointerEvents: 'none',
      }}
    >
      {toasts.map(t => (
        <div
          key={t.id}
          style={{
            background: 'rgba(20, 24, 30, 0.92)',
            color: 'rgba(255,255,255,0.9)',
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 12,
            padding: '10px 16px',
            fontSize: 13,
            fontFamily: 'var(--font-ui, system-ui)',
            fontWeight: 400,
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            animation: 'toast-slide-up 220ms ease-out',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {t.text}
        </div>
      ))}
      <style>{`
        @keyframes toast-slide-up {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  )
}

'use client'

import { usePathname } from 'next/navigation'

interface Props {
  onOpenLibrary: () => void
  // Some screens override the active tab explicitly
  activeOverride?: 0 | 1 | 2
}

// Icon opacity: 1.0 active, 0.45 inactive — matches design exactly
const op = (i: number, active: number) => i === active ? 1 : 0.45

export default function TopIcons({ onOpenLibrary, activeOverride }: Props) {
  const pathname = usePathname()
  const active = activeOverride !== undefined
    ? activeOverride
    : pathname.startsWith('/trends') ? 2 : 1  // 0=library, 1=memory, 2=trends

  return (
    <div style={{
      display: 'flex',
      gap: 36,
      justifyContent: 'center',
      alignItems: 'center',
      padding: '8px 0 12px',
      color: '#fff',
      position: 'relative',
      zIndex: 10,
    }}>

      {/* 0 — Layers / Library */}
      <svg
        style={{ opacity: op(0, active), cursor: 'pointer', display: 'block' }}
        width="22" height="22" viewBox="0 0 24 24"
        fill="none" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
        onClick={onOpenLibrary}
        aria-label="Library"
      >
        <polygon points="12 2 22 8 12 14 2 8" />
        <polyline points="2 14 12 20 22 14" />
      </svg>

      {/* 1 — Focus circle / Memory */}
      <a href="/chat?new=1" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', position: 'relative' }}>
        <span style={{ opacity: op(1, active), display: 'inline-flex', alignItems: 'center', position: 'relative' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.4">
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="12" r="2" fill="#fff" />
          </svg>
          {/* Underline indicator — only when active */}
          {active === 1 && (
            <span style={{
              position: 'absolute',
              bottom: -7,
              left: '50%',
              transform: 'translateX(-50%)',
              width: 10,
              height: 1,
              background: '#fff',
            }} />
          )}
        </span>
      </a>

      {/* 2 — Bar chart / Trends */}
      <a href="/trends" style={{ textDecoration: 'none', display: 'inline-flex' }}>
        <svg
          style={{ opacity: op(2, active), display: 'block' }}
          width="22" height="22" viewBox="0 0 24 24"
          fill="none" stroke="#fff" strokeWidth="1.4"
          aria-label="Trends"
        >
          <rect x="3"  y="14" width="3" height="7" fill="#fff" stroke="none" />
          <rect x="10" y="9"  width="3" height="12" fill="#fff" stroke="none" />
          <rect x="17" y="4"  width="3" height="17" fill="#fff" stroke="none" />
        </svg>
      </a>
    </div>
  )
}

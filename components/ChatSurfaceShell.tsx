'use client'

import { useState, useEffect, useRef } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import TopIcons from './TopIcons'
import HistoryDrawer from './HistoryDrawer'

export type SunriseTheme = 'sunrise' | 'sunshine' | 'sunny-night' | 'ember'

interface Props {
  children: React.ReactNode
  theme?: SunriseTheme
  // Chat page passes this so Library's "+" resets to fresh state without navigation
  onNewChat?: () => void
}

// Module-level cache so the name persists across client-side navigations
let _cachedName: string | null | undefined = undefined

export default function ChatSurfaceShell({ children, theme = 'sunrise', onNewChat }: Props) {
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [givenName, setGivenName] = useState<string | null>(_cachedName ?? null)
  const pathname  = usePathname()
  const router    = useRouter()
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (fetchedRef.current || _cachedName !== undefined) return
    fetchedRef.current = true
    fetch('/api/user/profile')
      .then(r => r.json())
      .then(d => {
        _cachedName = d.givenName ?? null
        setGivenName(_cachedName)
      })
      .catch(() => { _cachedName = null })
  }, [])

  function handleNewChat() {
    setLibraryOpen(false)
    if (pathname === '/chat') {
      onNewChat?.()
    } else {
      router.push('/chat?new=1')
    }
  }

  const themeClass = theme !== 'sunrise' ? `theme-${theme}` : ''

  return (
    <div
      className={`sr-bg ${themeClass}`}
      style={{
        position: 'fixed',
        top: 0, left: '50%',
        transform: 'translateX(-50%)',
        width: '100%', maxWidth: 512,
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        borderLeft:  '1px solid rgba(255,255,255,0.09)',
        borderRight: '1px solid rgba(255,255,255,0.09)',
        boxShadow: '-8px 0 24px rgba(0,0,0,0.18), 8px 0 24px rgba(0,0,0,0.18)',
        // Override font vars to Sunrise system for this subtree
        '--font-display': 'var(--font-fraunces, serif)',
        '--font-ui':      'var(--font-inter, system-ui)',
        '--font-mono':    'var(--font-plex-mono, monospace)',
      } as React.CSSProperties}
    >
      <TopIcons onOpenLibrary={() => setLibraryOpen(true)} />

      <HistoryDrawer
        isOpen={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        onNewChat={handleNewChat}
        givenName={givenName}
      />

      {/* Page content fills remaining space */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {children}
      </div>
    </div>
  )
}

'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'

interface Session {
  id: string
  title: string | null
  createdAt: string
  updatedAt: string
  preview: string
}

interface Props {
  isOpen: boolean
  onClose: () => void
  onNewChat: () => void
  givenName: string | null
}

function dateGroup(updatedAt: string): 'Today' | 'Yesterday' | 'This week' | 'Earlier' {
  const now  = new Date()
  const diff = (now.getTime() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24)
  if (diff < 1)  return 'Today'
  if (diff < 2)  return 'Yesterday'
  if (diff < 7)  return 'This week'
  return 'Earlier'
}

// ─── Sub-components ────────────────────────────────────────

function ThreadRow({ session, isLive, onClick, onArchive }: {
  session: Session; isLive: boolean; onClick: () => void; onArchive: () => void
}) {
  const time = new Date(session.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const title = session.title ?? (session.preview.slice(0, 48) || 'New conversation')

  const [offsetX, setOffsetX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [collapsing, setCollapsing] = useState(false)
  const startX = useRef(0)
  const THRESHOLD = 72

  function onTouchStart(e: React.TouchEvent) {
    startX.current = e.touches[0].clientX
    setDragging(true)
  }
  function onTouchMove(e: React.TouchEvent) {
    const dx = e.touches[0].clientX - startX.current
    if (dx < 0) setOffsetX(Math.max(dx, -THRESHOLD - 20))
  }
  function onTouchEnd() {
    setDragging(false)
    if (offsetX <= -THRESHOLD) {
      setOffsetX(-THRESHOLD) // snap to reveal
    } else {
      setOffsetX(0)
    }
  }

  function handleArchive() {
    setCollapsing(true)
    setTimeout(onArchive, 320)
  }

  return (
    <div style={{
      position: 'relative', overflow: 'hidden',
      height: collapsing ? 0 : undefined,
      opacity: collapsing ? 0 : 1,
      transition: collapsing ? 'height 300ms ease, opacity 280ms ease' : undefined,
    }}>
      {/* Archive action revealed behind row */}
      <div style={{
        position: 'absolute', right: 0, top: 0, bottom: 0,
        width: THRESHOLD,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(180,60,40,0.85)',
      }}>
        <button
          onClick={handleArchive}
          style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round">
            <polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/>
            <line x1="10" y1="12" x2="14" y2="12"/>
          </svg>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: '0.1em', color: '#fff' }}>ARCHIVE</span>
        </button>
      </div>

      {/* Swipeable row */}
      <button
        onClick={() => { if (offsetX !== 0) { setOffsetX(0) } else { onClick() } }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          width: '100%', textAlign: 'left',
          background: 'none', border: 'none',
          padding: '11px 20px',
          display: 'flex', alignItems: 'center', gap: 12,
          cursor: 'pointer',
          transform: `translateX(${offsetX}px)`,
          transition: dragging ? 'none' : 'transform 240ms cubic-bezier(.22,1,.36,1)',
          position: 'relative', zIndex: 1,
          backgroundColor: 'var(--sr-ink-1)',
        }}
        onMouseEnter={e => { if (offsetX === 0) e.currentTarget.style.background = 'rgba(255,255,255,0.05)' }}
        onMouseLeave={e => (e.currentTarget.style.background = 'var(--sr-ink-1)')}
      >
        <span style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
          background: isLive ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.2)',
          ...(isLive ? { boxShadow: '0 0 6px rgba(255,255,255,0.6)', animation: 'sr-live 2s ease-in-out infinite' } : {}),
        }} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 400,
            color: 'rgba(255,255,255,0.88)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 2,
          }}>
            {title}
          </div>
          {session.preview && (
            <div style={{
              fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 300,
              color: 'rgba(255,255,255,0.4)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {session.preview}
            </div>
          )}
        </div>

        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.06em', flexShrink: 0 }}>
          {time}
        </span>
      </button>
    </div>
  )
}

function GroupLabel({ label }: { label: string }) {
  return (
    <div style={{
      padding: '14px 20px 6px',
      fontFamily: 'var(--font-mono)',
      fontSize: 9, letterSpacing: '0.2em',
      color: 'rgba(255,255,255,0.28)',
      textTransform: 'uppercase',
    }}>
      {label}
    </div>
  )
}

// ─── Action sheet ──────────────────────────────────────────

function ActionSheet({ onClose, onSettings, onSignOut }: { onClose: () => void; onSettings: () => void; onSignOut: () => void }) {
  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, zIndex: 10 }}
      />
      <div style={{
        position: 'absolute', bottom: 72, left: 16, right: 16,
        zIndex: 11,
        background: 'rgba(30,24,22,0.97)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 16,
        overflow: 'hidden',
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}>
        {[
          { label: 'Settings', action: onSettings },
          { label: 'Sign out', action: onSignOut, danger: true },
        ].map(({ label, action, danger }) => (
          <button
            key={label}
            onClick={action}
            style={{
              width: '100%', textAlign: 'center',
              background: 'none', border: 'none',
              padding: '14px 20px',
              fontFamily: 'var(--font-ui)',
              fontSize: 15, fontWeight: 400,
              color: danger ? 'rgba(229,100,100,0.9)' : 'rgba(255,255,255,0.85)',
              cursor: 'pointer',
              borderBottom: label !== 'Sign out' ? '1px solid rgba(255,255,255,0.07)' : 'none',
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  )
}

// ─── Main drawer ───────────────────────────────────────────

export default function HistoryDrawer({ isOpen, onClose, onNewChat, givenName }: Props) {
  const router = useRouter()
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [showArchived, setShowArchived] = useState(false)
  const [filter, setFilter] = useState('All')
  const [search, setSearch] = useState('')
  const [actionSheetOpen, setActionSheetOpen] = useState(false)
  const [show, setShow] = useState(false)
  const [animOpen, setAnimOpen] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)

  // Lock body scroll while open so the page behind the drawer can't scroll on
  // iPhone PWA. Capture the previous value so a nested modal restores correctly.
  useEffect(() => {
    if (!isOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previousOverflow }
  }, [isOpen])

  useEffect(() => {
    if (isOpen) {
      setShow(true)
      const frame = requestAnimationFrame(() => setAnimOpen(true))
      return () => cancelAnimationFrame(frame)
    } else {
      setAnimOpen(false)
      setActionSheetOpen(false)
      const t = setTimeout(() => setShow(false), 360)
      return () => clearTimeout(t)
    }
  }, [isOpen])

  async function archiveSession(id: string) {
    await fetch(`/api/chat/sessions/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }) })
    setSessions(prev => prev.filter(s => s.id !== id))
  }

  // Fetch sessions; backfill untitled ones in background
  useEffect(() => {
    if (!isOpen) return
    setLoading(true)
    fetch(`/api/chat/sessions${showArchived ? '?archived=true' : ''}`)
      .then(r => r.json())
      .then(async d => {
        setSessions(d.sessions ?? [])
        const hasUntitled = (d.sessions ?? []).some((s: Session) => !s.title) && !showArchived
        if (hasUntitled) {
          try {
            await fetch('/api/chat/retitle', { method: 'POST' })
            const r2 = await fetch(`/api/chat/sessions${showArchived ? '?archived=true' : ''}`)
            const d2 = await r2.json()
            setSessions(d2.sessions ?? [])
          } catch { /* non-fatal */ }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [isOpen, showArchived])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  if (!show) return null

  const groups: ('Today' | 'Yesterday' | 'This week' | 'Earlier')[] = ['Today', 'Yesterday', 'This week', 'Earlier']
  const todayStr = new Date().toDateString()

  const filtered = sessions.filter(s => {
    if (search) {
      const title = s.title ?? s.preview
      if (!title.toLowerCase().includes(search.toLowerCase())) return false
    }
    return true
  })

  const initials = givenName?.[0]?.toUpperCase() ?? 'R'

  return (
    <>
      {/* Backdrop scrim */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 40,
          background: 'rgba(0,0,0,0.45)',
          opacity: animOpen ? 1 : 0,
          transition: 'opacity 280ms ease',
          pointerEvents: animOpen ? 'all' : 'none',
        }}
      />

      {/* Drawer panel */}
      <div
        ref={drawerRef}
        style={{
          position: 'fixed', top: 0, left: 0, bottom: 0,
          width: '85%', maxWidth: 340,
          zIndex: 50,
          background: `linear-gradient(180deg, var(--sr-ink-1) 0%, var(--sr-ink-2) 100%)`,
          borderTopRightRadius: 20,
          borderBottomRightRadius: 20,
          display: 'flex', flexDirection: 'column',
          opacity: animOpen ? 1 : 0,
          transform: animOpen ? 'translateX(0) scale(1)' : 'translateX(-8px) scale(0.98)',
          transition: 'opacity 220ms ease, transform 220ms ease',
          overflowY: 'auto',
          overscrollBehavior: 'contain',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'calc(20px + env(safe-area-inset-top)) 20px 12px',
          flexShrink: 0,
        }}>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
            aria-label="Close library"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1.6" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>

          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10, letterSpacing: '0.2em',
            color: 'rgba(255,255,255,0.45)',
            textTransform: 'uppercase',
          }}>
            Library · {sessions.length}
          </span>

          <button
            onClick={onNewChat}
            style={{
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.14)',
              borderRadius: 8, padding: '5px 10px',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              fontSize: 13, color: 'rgba(255,255,255,0.8)',
            }}
            aria-label="New chat"
          >
            +
          </button>
        </div>

        {/* Search */}
        <div style={{ padding: '0 16px 10px', flexShrink: 0 }}>
          <div style={{
            background: 'rgba(255,255,255,0.07)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 12,
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '9px 12px',
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1.6" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search threads..."
              style={{
                background: 'none', border: 'none', outline: 'none',
                fontFamily: 'var(--font-ui)',
                fontSize: 16, color: 'rgba(255,255,255,0.75)',
                width: '100%',
              }}
            />
          </div>
        </div>

        {/* Filter chips */}
        <div style={{
          display: 'flex', gap: 6,
          padding: '0 16px 14px',
          overflowX: 'auto', flexShrink: 0,
          scrollbarWidth: 'none',
        }}>
          {(['All', 'Today', 'This week'] as const).map(name => (
            <button
              key={name}
              onClick={() => { setFilter(name); setShowArchived(false) }}
              style={{
                flexShrink: 0,
                background: filter === name ? 'rgba(224,192,144,0.18)' : 'rgba(255,255,255,0.06)',
                border: `1px solid ${filter === name ? 'rgba(224,192,144,0.35)' : 'rgba(255,255,255,0.1)'}`,
                borderRadius: 999,
                padding: '5px 12px',
                fontFamily: 'var(--font-mono)',
                fontSize: 9.5, letterSpacing: '0.12em',
                color: filter === name ? 'var(--sr-cream)' : 'rgba(255,255,255,0.45)',
                cursor: 'pointer',
                textTransform: 'uppercase',
              }}
            >
              {name}
            </button>
          ))}
        </div>

        {/* Session list */}
        <div style={{ flex: 1, overflowY: 'auto', scrollbarWidth: 'none' }}>
          {loading ? (
            <div style={{ padding: '4px 0' }}>
              {[0,1,2,3,4].map(i => (
                <div key={i} style={{
                  padding: '11px 20px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{
                      height: 14, width: `${55 + (i % 3) * 12}%`, borderRadius: 3,
                      background: 'linear-gradient(100deg, rgba(255,255,255,0.04) 30%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.04) 70%)',
                      backgroundSize: '200% 100%',
                      animation: 'sr-shimmer 1.4s linear infinite',
                    }} />
                    <div style={{
                      height: 11, width: `${40 + (i % 4) * 10}%`, borderRadius: 3,
                      background: 'linear-gradient(100deg, rgba(255,255,255,0.04) 30%, rgba(255,255,255,0.1) 50%, rgba(255,255,255,0.04) 70%)',
                      backgroundSize: '200% 100%',
                      animation: 'sr-shimmer 1.4s linear infinite',
                    }} />
                  </div>
                </div>
              ))}
              <style>{`@keyframes sr-shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }`}</style>
            </div>
          ) : (
          <>
          {groups.map(group => {
            const groupSessions = filtered.filter(s => {
              if (filter === 'Today' && group !== 'Today') return false
              if (filter === 'This week' && (group === 'Earlier')) return false
              return dateGroup(s.updatedAt) === group
            })
            if (groupSessions.length === 0) return null
            return (
              <div key={group}>
                <GroupLabel label={group} />
                {groupSessions.map(session => (
                  <ThreadRow
                    key={session.id}
                    session={session}
                    isLive={new Date(session.updatedAt).toDateString() === todayStr}
                    onClick={() => {
                      onClose()
                      router.push(`/chat?sessionId=${session.id}`)
                    }}
                    onArchive={() => archiveSession(session.id)}
                  />
                ))}
              </div>
            )
          })}

          {filtered.length === 0 && (
            <div style={{
              padding: '40px 20px',
              textAlign: 'center',
              fontFamily: 'var(--font-ui)',
              fontSize: 13, color: 'rgba(255,255,255,0.28)',
            }}>
              {search ? 'No sessions match.' : 'No conversations yet.'}
            </div>
          )}
          </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          flexShrink: 0,
          borderTop: '1px solid rgba(255,255,255,0.07)',
          padding: 'calc(12px) 20px calc(16px + env(safe-area-inset-bottom))',
          position: 'relative',
        }}>
          {actionSheetOpen && (
            <ActionSheet
              onClose={() => setActionSheetOpen(false)}
              onSettings={() => { setActionSheetOpen(false); onClose(); router.push('/settings') }}
              onSignOut={() => { setActionSheetOpen(false); onClose(); router.push('/') }}
            />
          )}

          <button
            onClick={() => setActionSheetOpen(v => !v)}
            style={{
              width: '100%', textAlign: 'left',
              background: 'none', border: 'none',
              display: 'flex', alignItems: 'center', gap: 12,
              cursor: 'pointer', padding: 0,
            }}
          >
            {/* Avatar */}
            <div style={{
              width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
              background: 'var(--sr-terracotta)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'var(--font-display)',
              fontSize: 15, fontWeight: 400, color: '#fff',
            }}>
              {initials}
            </div>

            {/* Name + actions */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontFamily: 'var(--font-display)',
                fontSize: 14, fontWeight: 400,
                color: 'rgba(255,255,255,0.8)',
                marginBottom: 2,
              }}>
                {givenName ?? 'Account'}
              </div>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9, letterSpacing: '0.18em',
                color: 'rgba(255,255,255,0.3)',
                textTransform: 'uppercase',
              }}>
                Settings
              </div>
            </div>

            {/* Kebab */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="1.6" strokeLinecap="round">
              <circle cx="12" cy="5"  r="1" fill="rgba(255,255,255,0.3)" stroke="none" />
              <circle cx="12" cy="12" r="1" fill="rgba(255,255,255,0.3)" stroke="none" />
              <circle cx="12" cy="19" r="1" fill="rgba(255,255,255,0.3)" stroke="none" />
            </svg>
          </button>
        </div>
      </div>
    </>
  )
}

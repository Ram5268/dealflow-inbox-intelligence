'use client'

import { usePathname, useRouter } from 'next/navigation'
import { Home, MessageCircle, TrendingUp, User } from 'lucide-react'

const ITEMS = [
  { icon: Home,          href: '/',         match: (p: string) => p === '/' },
  { icon: MessageCircle, href: '/chat',      match: (p: string) => p.startsWith('/chat') || p.startsWith('/opportunities') },
  { icon: TrendingUp,    href: '/trends',    match: (p: string) => p.startsWith('/trends') },
  { icon: User,          href: '/settings',  match: (p: string) => p.startsWith('/settings') },
]

export default function BottomNav() {
  const pathname = usePathname()
  const router = useRouter()

  return (
    <div style={{
      position: 'fixed',
      bottom: 24,
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 100,
      padding: '0 16px',
      width: '100%',
      maxWidth: 512,
      display: 'flex',
      justifyContent: 'center',
      pointerEvents: 'none',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        background: 'rgba(255,255,255,0.08)',
        border: '1px solid rgba(255,255,255,0.14)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderRadius: 50,
        padding: '8px 8px',
        pointerEvents: 'all',
      }}>
        {ITEMS.map(({ icon: Icon, href, match }) => {
          const active = match(pathname)
          return (
            <button
              key={href}
              onClick={() => router.push(href)}
              style={{
                width: active ? 64 : 52,
                height: 52,
                borderRadius: 40,
                border: 'none',
                background: active ? 'rgba(30,30,40,0.75)' : 'transparent',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                transition: 'all 0.25s cubic-bezier(0.4,0,0.2,1)',
                flexShrink: 0,
              }}
            >
              <Icon
                size={22}
                strokeWidth={active ? 2 : 1.5}
                color={active ? '#ffffff' : 'rgba(255,255,255,0.45)'}
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}

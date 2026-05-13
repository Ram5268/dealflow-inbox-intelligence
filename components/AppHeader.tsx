'use client'

import { useRouter } from 'next/navigation'
import { Menu, X, MessageCircle, TrendingUp, User } from 'lucide-react'
import { MenuContainer, MenuItem } from '@/components/ui/fluid-menu'

export default function AppHeader() {
  const router = useRouter()

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '52px 20px 14px',
      flexShrink: 0,
      borderBottom: '1px solid rgba(255,255,255,0.07)',
    }}>
      <MenuContainer>
        {/* Trigger — Menu / X */}
        <MenuItem
          icon={
            <div style={{ position: 'relative', width: 20, height: 20 }}>
              <span className="menu-icon-open" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'opacity 200ms, transform 200ms' }}>
                <Menu size={18} strokeWidth={1.8} color="rgba(255,255,255,0.85)" />
              </span>
              <span className="menu-icon-close" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'opacity 200ms, transform 200ms' }}>
                <X size={18} strokeWidth={1.8} color="rgba(255,255,255,0.85)" />
              </span>
            </div>
          }
        />

        {/* AI Search */}
        <MenuItem
          icon={<MessageCircle size={17} strokeWidth={1.8} color="rgba(255,255,255,0.8)" />}
          onClick={() => router.push('/chat')}
        />

        {/* Trends */}
        <MenuItem
          icon={<TrendingUp size={17} strokeWidth={1.8} color="rgba(255,255,255,0.8)" />}
          onClick={() => router.push('/trends')}
        />

        {/* Profile / Settings */}
        <MenuItem
          icon={<User size={17} strokeWidth={1.8} color="rgba(255,255,255,0.8)" />}
          onClick={() => router.push('/settings')}
        />
      </MenuContainer>

      <style>{`
        [data-expanded="false"] .menu-icon-close { opacity: 0; transform: rotate(-90deg) scale(0.7); }
        [data-expanded="false"] .menu-icon-open  { opacity: 1; transform: rotate(0deg) scale(1); }
        [data-expanded="true"]  .menu-icon-open  { opacity: 0; transform: rotate(90deg) scale(0.7); }
        [data-expanded="true"]  .menu-icon-close { opacity: 1; transform: rotate(0deg) scale(1); }
      `}</style>
    </div>
  )
}

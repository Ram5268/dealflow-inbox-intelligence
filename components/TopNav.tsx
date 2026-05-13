'use client'

// TopNav now delegates to the Sunrise nav system.
// Pages still importing TopNav automatically get TopIcons + Library drawer.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import TopIcons from './TopIcons'
import HistoryDrawer from './HistoryDrawer'

export default function TopNav() {
  const router = useRouter()
  const [libraryOpen, setLibraryOpen] = useState(false)

  return (
    <>
      <TopIcons onOpenLibrary={() => setLibraryOpen(true)} />
      <HistoryDrawer
        isOpen={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        onNewChat={() => { setLibraryOpen(false); router.push('/chat?new=1') }}
        givenName={null}
      />
    </>
  )
}

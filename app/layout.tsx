import type { Metadata, Viewport } from 'next'
import { Geist, Playfair_Display, Fraunces, Inter, IBM_Plex_Mono } from 'next/font/google'
import './globals.css'
import Toast from '@/components/Toast'

// Existing — used outside the chat surface
const geist = Geist({ variable: '--font-geist', subsets: ['latin'], display: 'swap' })
const playfair = Playfair_Display({ variable: '--font-playfair', subsets: ['latin'], weight: ['400','500','600','700'], display: 'swap' })

// Sunrise design system fonts — scoped to chat surface via CSS vars
const fraunces = Fraunces({ variable: '--font-fraunces', subsets: ['latin'], weight: ['300','400'], display: 'swap' })
const inter = Inter({ variable: '--font-inter', subsets: ['latin'], weight: ['300','400','500'], display: 'swap' })
const ibmPlexMono = IBM_Plex_Mono({ variable: '--font-plex-mono', subsets: ['latin'], weight: ['400'], display: 'swap' })

export const metadata: Metadata = {
  title: 'DealFlow',
  description: 'Real estate deal intelligence from your inbox',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'DealFlow',
  },
  icons: {
    apple: '/icon-180.png',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${playfair.variable} ${fraunces.variable} ${inter.variable} ${ibmPlexMono.variable}`} style={{ height: '100%' }}>
      <body style={{ height: '100%', display: 'flex', flexDirection: 'column', margin: 0 }}>
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', maxWidth: '512px', width: '100%', margin: '0 auto' }}>
          {children}
        </main>
        <Toast />
      </body>
    </html>
  )
}

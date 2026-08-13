import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'DealFlow',
    short_name: 'DealFlow',
    description: 'Real estate deal intelligence from your inbox',
    start_url: '/',
    display: 'standalone',
    background_color: '#3A1C0C',
    theme_color: '#3A1C0C',
    orientation: 'portrait',
    launch_handler: { client_mode: 'navigate-existing' },
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
      {
        src: '/icon-180.png',
        sizes: '180x180',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  }
}

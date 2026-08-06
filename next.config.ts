import type { NextConfig } from 'next'

console.log('[config] TEST_MODE_ONLY =', process.env.TEST_MODE_ONLY === 'true' ? 'ON (seed data only)' : 'OFF (real data allowed)')

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  serverExternalPackages: ['pdfjs-dist', 'canvas', 'mammoth', 'xlsx'],
}

export default nextConfig

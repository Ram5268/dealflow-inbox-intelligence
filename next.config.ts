import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  serverExternalPackages: ['pdfjs-dist', 'canvas', 'mammoth', 'xlsx'],
}

export default nextConfig

export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'

export async function GET() {
  const key  = process.env.RAPIDAPI_KEY ?? ''
  const host = process.env.RAPIDAPI_SE_HOST ?? 'streeteasy-api.p.rapidapi.com'

  if (!key) return NextResponse.json({ error: 'RAPIDAPI_KEY not set' }, { status: 500 })

  // Try different endpoint paths to find the active listings search
  const endpoints = [
    '/sales?areas=williamsburg&limit=2',
    '/sales/active?areas=williamsburg&limit=2',
    '/listings?areas=williamsburg&limit=2&status=active',
    '/properties/search?areas=williamsburg&limit=2',
    '/for-sale?areas=williamsburg&limit=2',
  ]

  const results: Record<string, unknown>[] = []
  for (const path of endpoints) {
    const url = `https://${host}${path}`
    const r = await fetch(url, { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host } })
    const body = await r.json()
    results.push({ url, status: r.status, topKeys: Object.keys(body as object), snippet: JSON.stringify(body).slice(0, 200) })
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  return NextResponse.json({ results })
}

export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'

export async function GET() {
  const key  = process.env.RAPIDAPI_KEY ?? ''
  const host = process.env.RAPIDAPI_SE_HOST ?? 'streeteasy-api.p.rapidapi.com'

  if (!key) return NextResponse.json({ error: 'RAPIDAPI_KEY not set' }, { status: 500 })

  const paths = [
    '/',
    '/sale-listings?areas=williamsburg&limit=1',
    '/v1/sales/search?areas=williamsburg&limit=1',
    '/v2/sales/search?areas=williamsburg&limit=1',
    '/api/sales/search?areas=williamsburg&limit=1',
    '/search?areas=williamsburg&limit=1&type=sale',
  ]

  const results = []
  for (const path of paths) {
    const url = `https://${host}${path}`
    try {
      const r = await fetch(url, { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host } })
      const body = await r.json()
      results.push({ path, status: r.status, response: JSON.stringify(body).slice(0, 150) })
    } catch (e) {
      results.push({ path, error: String(e) })
    }
    await new Promise(r => setTimeout(r, 1500))
  }

  return NextResponse.json({ host, results })
}

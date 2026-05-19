export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'

export async function GET() {
  const key  = process.env.RAPIDAPI_KEY ?? ''
  const host = process.env.RAPIDAPI_SE_HOST ?? 'streeteasy-api.p.rapidapi.com'

  if (!key) return NextResponse.json({ error: 'RAPIDAPI_KEY not set' }, { status: 500 })

  const url = `https://${host}/v1/sales/search?areas=williamsburg&limit=2`
  const r = await fetch(url, { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host } })
  const body = await r.json() as Record<string, unknown>
  const listings = (body.listings as Record<string, unknown>[] | undefined) ?? []

  return NextResponse.json({
    url,
    status: r.status,
    topLevelKeys: Object.keys(body),
    listingCount: listings.length,
    firstListingAllFields: listings[0] ?? null,
  })
}

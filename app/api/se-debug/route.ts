export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'

export async function GET() {
  const key  = process.env.RAPIDAPI_KEY ?? ''
  const host = process.env.RAPIDAPI_SE_HOST ?? 'streeteasy-api.p.rapidapi.com'

  if (!key) return NextResponse.json({ error: 'RAPIDAPI_KEY not set' }, { status: 500 })

  // Test only Dilan's known working endpoint — no status filter to see ALL listings
  const url1 = `https://${host}/sales/past/search?areas=williamsburg&limit=2`
  const r1 = await fetch(url1, { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host } })
  const body1 = await r1.json() as Record<string, unknown>
  const listings1 = (body1.listings as Record<string, unknown>[] | undefined) ?? []

  return NextResponse.json({
    url: url1,
    status: r1.status,
    totalCount: (body1.pagination as Record<string, unknown> | undefined)?.count ?? null,
    firstListingAllFields: listings1[0] ?? null,
    secondListing: listings1[1] ?? null,
    topLevelKeys: Object.keys(body1),
  })
}

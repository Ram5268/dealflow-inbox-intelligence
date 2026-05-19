export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'

export async function GET() {
  const key  = process.env.RAPIDAPI_KEY ?? ''
  const host = process.env.RAPIDAPI_SE_HOST ?? 'streeteasy-api.p.rapidapi.com'

  if (!key) return NextResponse.json({ error: 'RAPIDAPI_KEY not set' }, { status: 500 })

  // Test 1: basic search, no filters — just see what comes back
  const url1 = `https://${host}/sales/search?areas=williamsburg&limit=2`
  const r1 = await fetch(url1, {
    headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host },
  })
  const raw1 = await r1.json() as Record<string, unknown>

  // Show full first listing so we can see exact field names
  const listings = (raw1.listings as Record<string, unknown>[] | undefined) ?? []
  const firstListing = listings[0] ?? null

  // Test 2: same with beds and price params (our current param names)
  const url2 = `https://${host}/sales/search?areas=williamsburg&limit=2&minBeds=2&maxBeds=2&maxPrice=1500000`
  const r2 = await fetch(url2, {
    headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host },
  })
  const raw2 = await r2.json() as Record<string, unknown>

  return NextResponse.json({
    test1_url: url1,
    test1_count: listings.length,
    test1_firstListing: firstListing,
    test1_allKeys: firstListing ? Object.keys(firstListing) : [],
    test2_url: url2,
    test2_count: ((raw2.listings as unknown[]) ?? []).length,
    test2_firstListing: ((raw2.listings as Record<string, unknown>[] | undefined) ?? [])[0] ?? null,
  })
}

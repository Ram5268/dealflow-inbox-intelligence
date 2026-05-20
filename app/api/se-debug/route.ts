export const dynamic = 'force-dynamic'
import { NextResponse } from 'next/server'

export async function GET() {
  const key  = process.env.RAPIDAPI_KEY ?? ''
  const host = process.env.RAPIDAPI_SE_HOST ?? 'streeteasy-api.p.rapidapi.com'

  if (!key) return NextResponse.json({ error: 'RAPIDAPI_KEY not set' }, { status: 500 })

  // Test 1: lookup by address slug instead of numeric ID
  const url1 = `https://${host}/sales/109-devoe-street-brooklyn/garden-2`
  const r1 = await fetch(url1, { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host } })
  const body1 = await r1.json() as Record<string, unknown>

  await new Promise(r => setTimeout(r, 2000))

  // Test 2: lookup a known active listing ID from the similar listings in the response
  // (id 1817612 = 10 Park Ave 3F, status ACTIVE from earlier response)
  const url2 = `https://${host}/sales/1817612`
  const r2 = await fetch(url2, { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host } })
  const body2 = await r2.json() as Record<string, unknown>
  const similar = (body2.getSimilarSaleListings as Record<string,unknown>[] | undefined) ?? []

  return NextResponse.json({
    slug_test: { url: url1, status: r1.status, keys: Object.keys(body1), snippet: JSON.stringify(body1).slice(0,200) },
    active_id_test: {
      url: url2,
      status: r2.status,
      listing_id: body2.listing_id,
      quick_url: (body2.property as Record<string,unknown> | undefined)?.quick_url,
      similar_active: similar.filter((s: Record<string,unknown>) => (s.listingDigest as Record<string,unknown>)?.status === 'ACTIVE').slice(0,3).map((s: Record<string,unknown>) => {
        const d = s.listingDigest as Record<string,unknown>
        return { id: d?.id, status: d?.status, price: d?.price, beds: d?.bedroomCount, street: d?.street, unit: d?.unit }
      })
    }
  })
}

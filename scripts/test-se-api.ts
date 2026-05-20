const key  = process.env.RAPIDAPI_KEY ?? ''
const host = process.env.RAPIDAPI_SE_HOST ?? 'nyc-real-estate-api.p.rapidapi.com'

async function get(path: string) {
  const url = `https://${host}${path}`
  const r = await fetch(url, { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': host } })
  const body = await r.json()
  return { url, status: r.status, body }
}

async function main() {
  if (!key) { console.error('Set RAPIDAPI_KEY env var'); process.exit(1) }

  console.log('Searching: brooklyn 2BR under $1.5M...')
  const t = await get('/sales/search?areas=brooklyn&minBeds=2&maxBeds=2&maxPrice=1500000&limit=50&offset=0')
  console.log('status:', t.status)

  const b = t.body as { pagination?: { count: number }, listings?: Record<string,unknown>[] }
  const all = b.listings ?? []

  // Filter to Williamsburg bounding box
  const WB = { minLat: 40.700, maxLat: 40.730, minLng: -73.975, maxLng: -73.920 }
  const inWilliamsburg = all.filter(l => {
    const lat = Number(l.latitude), lng = Number(l.longitude)
    return lat >= WB.minLat && lat <= WB.maxLat && lng >= WB.minLng && lng <= WB.maxLng
  })

  console.log(`Total Brooklyn 2BR under $1.5M: ${b.pagination?.count ?? '?'}`)
  console.log(`In Williamsburg bounds: ${inWilliamsburg.length} of ${all.length} fetched`)
  inWilliamsburg.slice(0, 5).forEach(l => console.log(`  $${Number(l.price).toLocaleString()} → ${l.url}`))
}

main().catch(console.error)

// Test streeteasy-api.p.rapidapi.com — Dilan's API
// Run: RAPIDAPI_KEY="..." npx tsx --no-cache scripts/test-se-api2.ts

const KEY  = process.env.RAPIDAPI_KEY ?? ''
const HOST = 'streeteasy-api.p.rapidapi.com'

async function get(path: string) {
  const url = `https://${HOST}${path}`
  console.log('GET', url)
  const r = await fetch(url, {
    headers: { 'x-rapidapi-key': KEY, 'x-rapidapi-host': HOST }
  })
  const body = await r.json()
  return { status: r.status, body }
}

async function main() {
  if (!KEY) { console.error('Set RAPIDAPI_KEY'); process.exit(1) }

  // First — discover what endpoints exist by trying the root
  console.log('\n=== 1. Try active sales search for Williamsburg ===')
  const r1 = await get('/sales/search?areas=williamsburg&minBeds=2&maxBeds=2&maxPrice=1500000&limit=5')
  console.log('Status:', r1.status)
  console.log('Body keys:', Object.keys(r1.body as object))
  console.log('Sample:', JSON.stringify(r1.body).slice(0, 400))

  console.log('\n=== 2. Try with WILLIAMSBURG (uppercase) ===')
  const r2 = await get('/sales/search?areas=WILLIAMSBURG&minBeds=2&maxBeds=2&maxPrice=1500000&limit=5')
  console.log('Status:', r2.status)
  console.log('Sample:', JSON.stringify(r2.body).slice(0, 400))

  console.log('\n=== 3. Try /properties endpoint ===')
  const r3 = await get('/properties?areas=williamsburg&minBeds=2&maxPrice=1500000&limit=5')
  console.log('Status:', r3.status)
  console.log('Sample:', JSON.stringify(r3.body).slice(0, 400))

  console.log('\n=== 4. Try /listings endpoint ===')
  const r4 = await get('/listings?area=williamsburg&beds=2&maxPrice=1500000&limit=5')
  console.log('Status:', r4.status)
  console.log('Sample:', JSON.stringify(r4.body).slice(0, 400))

  console.log('\n=== 5. Try getSimilarSaleListings (what Dilan uses) ===')
  // Try with a known listing ID to see what getSimilarSaleListings returns
  const r5 = await get('/getSimilarSaleListings?id=1828218')
  console.log('Status:', r5.status)
  console.log('Sample:', JSON.stringify(r5.body).slice(0, 600))
}

main().catch(console.error)

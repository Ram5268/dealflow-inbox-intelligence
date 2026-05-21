// Test whether StreetEasy search pages return listing data in server-side HTML.
// Run: npx tsx --no-cache scripts/test-se-scrape.ts

const rememberToken = decodeURIComponent(process.env.SE_REMEMBER_USER_TOKEN ?? '')
const authToken     = decodeURIComponent(process.env.SE_USER_AUTH_TOKEN ?? '')

const SEARCH_URL = 'https://streeteasy.com/for-sale/williamsburg/price:-1500000|beds:2?sort_by=se_score'

async function fetchPage(withCookies: boolean) {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  }
  if (withCookies && rememberToken) {
    headers['Cookie'] = `remember_user_token=${rememberToken}; user_auth_token=${authToken}`
  }

  const res = await fetch(SEARCH_URL, { headers })
  const html = await res.text()
  return { status: res.status, finalUrl: res.url, html }
}

async function main() {
  console.log('Tokens present:', !!rememberToken, !!authToken)
  console.log('URL:', SEARCH_URL)
  console.log()

  // Test WITH cookies
  console.log('--- WITH cookies ---')
  const withAuth = await fetchPage(true)
  console.log('Status:', withAuth.status)
  console.log('Final URL (after redirects):', withAuth.finalUrl)
  console.log('HTML length:', withAuth.html.length, 'chars')
  console.log('Bot detection:', withAuth.html.includes('Access to this page has been denied') || withAuth.html.includes('Press & Hold'))
  console.log('Has __NEXT_DATA__:', withAuth.html.includes('__NEXT_DATA__'))

  // Count sale hrefs
  const saleHrefs = [...withAuth.html.matchAll(/href="(\/(?:sale|rental|building)\/[^"?#\s]+)"/g)]
  console.log('Sale/rental/building hrefs found:', saleHrefs.length)
  if (saleHrefs.length > 0) {
    console.log('First 5:', saleHrefs.slice(0, 5).map(m => m[1]))
  }

  // Check __NEXT_DATA__ content
  const ndMatch = withAuth.html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (ndMatch) {
    console.log('__NEXT_DATA__ length:', ndMatch[1].length, 'chars')
    // Look for price-like values
    const prices = [...ndMatch[1].matchAll(/"price"\s*:\s*(\d+)/g)].slice(0, 5)
    console.log('Price values in __NEXT_DATA__:', prices.map(m => m[1]))
    // Check for listing arrays
    const hasListings = ndMatch[1].includes('"listings"') || ndMatch[1].includes('"listingId"') || ndMatch[1].includes('"ListingKey"')
    console.log('Looks like it has listings data:', hasListings)
    // Save a snippet for inspection
    console.log('\n__NEXT_DATA__ first 500 chars:')
    console.log(ndMatch[1].slice(0, 500))
  } else {
    console.log('No __NEXT_DATA__ found')
    // Check if it's a redirect to login
    console.log('Has login redirect:', withAuth.html.includes('sign_in') || withAuth.html.includes('login'))
    console.log('\nHTML first 500 chars:')
    console.log(withAuth.html.slice(0, 500))
  }

  // Test WITHOUT cookies (just to compare)
  console.log('\n--- WITHOUT cookies ---')
  const noAuth = await fetchPage(false)
  console.log('Status:', noAuth.status)
  console.log('Final URL:', noAuth.finalUrl)
  console.log('HTML length:', noAuth.html.length, 'chars')
  const saleHrefsNoAuth = [...noAuth.html.matchAll(/href="(\/(?:sale|rental|building)\/[^"?#\s]+)"/g)]
  console.log('Sale hrefs:', saleHrefsNoAuth.length)
}

main().catch(console.error)

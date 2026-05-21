// Test what the StreetEasy hotsheet actually returns
// Run: npx tsx --no-cache scripts/test-hotsheet.ts

const rememberToken = decodeURIComponent(process.env.SE_REMEMBER_USER_TOKEN ?? '')
const authToken     = decodeURIComponent(process.env.SE_USER_AUTH_TOKEN ?? '')

async function fetchPage(url: string) {
  const res = await fetch(url, {
    headers: {
      Cookie: `remember_user_token=${rememberToken}; user_auth_token=${authToken}`,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'text/html',
    },
  })
  return { status: res.status, html: await res.text(), finalUrl: res.url }
}

async function main() {
  // Yesterday's date
  const d = new Date()
  d.setDate(d.getDate() - 1)
  const date = d.toISOString().slice(0, 10)

  console.log('Testing hotsheet for date:', date)
  console.log('Tokens present:', !!rememberToken, !!authToken)

  for (const type of ['sale', 'rental'] as const) {
    const url = `https://streeteasy.com/nyc/hotsheets/${type}/${date}`
    console.log(`\n=== ${type.toUpperCase()} HOTSHEET ===`)
    console.log('URL:', url)

    const { status, html, finalUrl } = await fetchPage(url)
    console.log('Status:', status)
    console.log('Final URL:', finalUrl)
    console.log('HTML length:', html.length, 'chars')
    console.log('Bot detection:', html.includes('Press & Hold') || html.includes('Access to this page has been denied'))

    // Count listing entries — look for price patterns
    const prices = html.match(/\$[\d,]+/g) ?? []
    const bigPrices = prices.filter(p => parseInt(p.replace(/[$,]/g, '')) > 50000)
    console.log('Price values found (>$50k):', bigPrices.length)
    console.log('Sample prices:', bigPrices.slice(0, 5))

    // Check for StreetEasy listing IDs/URLs in the HTML
    const seLinks = html.match(/href="\/(?:sale|rental)\/(\d+)"/g) ?? []
    console.log('Direct listing links (/sale/ID or /rental/ID):', seLinks.length)
    if (seLinks.length > 0) console.log('Sample links:', seLinks.slice(0, 5))

    // Check for pagination
    const hasPagination = html.includes('next') || html.includes('pagination') || html.includes('page=') || html.includes('offset=')
    console.log('Has pagination indicators:', hasPagination)

    // Check for "Hotsheet:" section
    console.log('Has Hotsheet section:', html.includes('Hotsheet:'))

    // Count address-like patterns
    const addresses = html.match(/\d+\s+[A-Z][a-z]+\s+(?:Street|Avenue|Place|Road|Drive|Boulevard|Lane|Court|Way|St|Ave|Blvd)/g) ?? []
    console.log('Address patterns found:', addresses.length)
    if (addresses.length > 0) console.log('Sample addresses:', addresses.slice(0, 5))

    // Show a snippet of the actual content
    const hotsheetIdx = html.indexOf('Hotsheet:')
    if (hotsheetIdx > -1) {
      console.log('\nContent after "Hotsheet:":', html.slice(hotsheetIdx, hotsheetIdx + 800))
    } else {
      console.log('\nFirst 500 chars of body:')
      const bodyStart = html.indexOf('<body')
      console.log(html.slice(bodyStart > 0 ? bodyStart : 0, bodyStart + 500))
    }
  }
}

main().catch(console.error)

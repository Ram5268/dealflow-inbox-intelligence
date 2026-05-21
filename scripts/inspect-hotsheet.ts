// Deep inspection of hotsheet HTML structure
import { writeFileSync } from 'fs'

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
  const d = new Date()
  d.setDate(d.getDate() - 1)
  const date = d.toISOString().slice(0, 10)

  // Fetch sale hotsheet
  const { html } = await fetchPage(`https://streeteasy.com/nyc/hotsheets/sale/${date}`)

  // Save full HTML for manual inspection
  writeFileSync('/tmp/hotsheet-sale.html', html)
  console.log('Saved to /tmp/hotsheet-sale.html')

  // Find the hotsheets div and print a good chunk
  const start = html.indexOf("<div class='hotsheets'>")
  if (start === -1) { console.log('No hotsheets div found'); return }

  const section = html.slice(start, start + 8000)
  console.log('\n=== HOTSHEET HTML STRUCTURE ===')
  console.log(section)

  // Find pagination
  const paginationPatterns = [
    /page=\d+/g,
    /offset=\d+/g,
    /\?page/g,
    /next_page/g,
    /class=['"].*pag.*['"]/g,
    /href="[^"]*hotsheet[^"]*"/g,
  ]
  console.log('\n=== PAGINATION PATTERNS ===')
  for (const re of paginationPatterns) {
    const matches = html.match(re) ?? []
    if (matches.length) console.log(re.source, '->', matches.slice(0, 5))
  }

  // Count total listing blocks
  const listingCount = (html.match(/<a class="title"/g) ?? []).length
  console.log('\nTotal listing blocks on this page:', listingCount)

  // Check if there's a "next page" link
  const nextPageMatch = html.match(/href="([^"]*hotsheet[^"]*)"[^>]*>.*?[Nn]ext/s)
  console.log('Next page link:', nextPageMatch?.[1] ?? 'not found')

  // Look for total count
  const countMatch = html.match(/<b>(\d+)<\/b>\s*new (?:sales|rentals)/)
  console.log('Total announced:', countMatch?.[1])
  console.log('Listings on this page:', listingCount)
  console.log('Are they equal?', countMatch?.[1] === String(listingCount))
}

main().catch(console.error)

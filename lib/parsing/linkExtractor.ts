// URL extractor + classifier for email body content. Pure regex + URL parsing,
// no network. Phase 3's ingestion pipeline uses this to enumerate links worth
// crawling/downloading from each email body.

export type LinkType = 'html' | 'pdf' | 'image' | 'dropbox' | 'drive' | 'office' | 'unknown'

export interface ExtractedLink {
  url:      string
  type:     LinkType
  hostname: string
}

const URL_REGEX  = /https?:\/\/[^\s<>"']+/gi
const PDF_EXT    = /\.pdf(\?|$)/i
const IMAGE_EXT  = /\.(jpe?g|png|gif|webp|bmp|tiff)(\?|$)/i
const OFFICE_EXT = /\.(docx?|xlsx?|pptx?)(\?|$)/i

const DROPBOX_HOSTS = new Set(['dropbox.com', 'www.dropbox.com', 'dl.dropboxusercontent.com'])
const DRIVE_HOSTS   = new Set(['drive.google.com', 'docs.google.com'])

const IMAGE_CDN_HOSTS = new Set([
  'res.cloudinary.com',
  'images.compass.com',
  'photos.streeteasy.com',
  'photos.zillowstatic.com',
  'images.unsplash.com',
  'imagedelivery.net',   // Cloudflare Images
])

function classify(url: string): LinkType {
  let parsed: URL
  try { parsed = new URL(url) } catch { return 'unknown' }
  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname

  if (DROPBOX_HOSTS.has(host))   return 'dropbox'
  if (DRIVE_HOSTS.has(host))     return 'drive'
  if (IMAGE_CDN_HOSTS.has(host)) return 'image'
  if (PDF_EXT.test(path))        return 'pdf'
  if (IMAGE_EXT.test(path))      return 'image'
  if (OFFICE_EXT.test(path))     return 'office'
  return 'html'
}

export function extractLinks(text: string): ExtractedLink[] {
  if (!text) return []
  const matches = text.match(URL_REGEX) ?? []
  const seen = new Set<string>()
  const out: ExtractedLink[] = []

  for (const raw of matches) {
    // Strip trailing punctuation that's typically NOT part of the URL.
    const url = raw.replace(/[.,;!?)\]>]+$/, '')
    if (seen.has(url)) continue
    seen.add(url)

    let hostname = ''
    try { hostname = new URL(url).hostname } catch { continue }
    out.push({ url, type: classify(url), hostname })
  }
  return out
}

// ── Scrape filter ──────────────────────────────────────────────────────────
// Drops URLs that are guaranteed junk for retrieval purposes — tracking
// pixels, unsubscribe paths, email-service redirects, social share buttons.
// Caps remaining URLs at MAX_PER_EMAIL so a single newsletter can't blow the
// Firecrawl budget. Skips heuristically when a URL has many query params
// (signature of tracking redirects).

const SCRAPE_HOST_DENYLIST = new Set([
  // Social
  'facebook.com', 'www.facebook.com', 'twitter.com', 'x.com',
  'linkedin.com', 'www.linkedin.com', 'instagram.com', 'youtube.com',
  // Common email tracking / redirect domains
  'links.mailchimp.com', 'mandrillapp.com',
  'click.email.compass.com', 't.email.compass.com',
  'tracking.email.streeteasy.com', 'click.email.streeteasy.com',
  'sendgrid.net', 'click.sendgrid.net',
  'list-manage.com', 'links.list-manage.com',
])

const SCRAPE_PATH_DENYLIST = [
  /\/unsubscribe/i,
  /\/preferences/i,
  /manage-?subscription/i,
  /opt-?out/i,
  /\/pixel/i,
  /\/beacon/i,
  /\/track\//i,
  /\/click\//i,
  /\.gif(\?|$)/i,
  /1x1\.png/i,
]

const MAX_PER_EMAIL = 3        // hard cap on Firecrawl calls per email
const MAX_QUERY_PARAMS = 6     // tracking redirects typically have many params

function isScrapeWorthy(link: ExtractedLink): boolean {
  // Only HTML links are scrape candidates (PDF/Dropbox/Drive go through
  // Phase 3C's download path, not Firecrawl).
  if (link.type !== 'html') return false

  let parsed: URL
  try { parsed = new URL(link.url) } catch { return false }

  if (SCRAPE_HOST_DENYLIST.has(parsed.hostname.toLowerCase())) return false
  if (SCRAPE_PATH_DENYLIST.some(rx => rx.test(parsed.pathname))) return false
  if ([...parsed.searchParams.keys()].length > MAX_QUERY_PARAMS) return false

  return true
}

export interface ScrapeFilterResult {
  scrape:   ExtractedLink[]    // pass-through, will be sent to Firecrawl
  deferred: ExtractedLink[]    // non-html types, recorded as LinkedResource only
  filtered: number             // count of HTML URLs the filter dropped (for logging)
}

export function filterScrapeWorthyLinks(links: ExtractedLink[]): ScrapeFilterResult {
  const scrape:   ExtractedLink[] = []
  const deferred: ExtractedLink[] = []
  let filtered = 0

  for (const link of links) {
    if (link.type !== 'html') {
      deferred.push(link)
      continue
    }
    if (!isScrapeWorthy(link)) {
      filtered++
      continue
    }
    if (scrape.length >= MAX_PER_EMAIL) {
      filtered++
      continue
    }
    scrape.push(link)
  }

  return { scrape, deferred, filtered }
}

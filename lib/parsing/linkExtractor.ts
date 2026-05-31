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

function classify(url: string): LinkType {
  let parsed: URL
  try { parsed = new URL(url) } catch { return 'unknown' }
  const host = parsed.hostname.toLowerCase()
  const path = parsed.pathname

  if (DROPBOX_HOSTS.has(host)) return 'dropbox'
  if (DRIVE_HOSTS.has(host))   return 'drive'
  if (PDF_EXT.test(path))      return 'pdf'
  if (IMAGE_EXT.test(path))    return 'image'
  if (OFFICE_EXT.test(path))   return 'office'
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

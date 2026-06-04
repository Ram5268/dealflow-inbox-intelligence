// Tier 1 — plain fetch + Mozilla Readability + linkedom + turndown.
// Covers the large majority of broker/listing pages (Compass, Elliman,
// Corcoran, broker blogs, news). 5s timeout; returns null on any failure so
// the waterfall falls through to Tier 2.
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { htmlToMarkdown } from './htmlToMarkdown'

const TIMEOUT_MS = 5_000
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) DealFlowBot/1.0'

export async function scrapeTier1(url: string): Promise<{ markdown: string } | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  let html: string
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      signal:  ctrl.signal,
      redirect: 'follow',
    })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') ?? ''
    if (ct && !ct.includes('html')) return null // PDFs/images/etc. aren't Tier 1's job
    html = await res.text()
  } catch {
    return null // timeout / network / DNS — fall through to Tier 2
  } finally {
    clearTimeout(timer)
  }

  try {
    const { document } = parseHTML(html)
    // Readability expects a DOM Document; linkedom's document is compatible at
    // runtime but typed separately, hence the cast.
    const article = new Readability(document as unknown as Document).parse()
    const contentHtml = article?.content ?? ''
    if (!contentHtml) return null
    const markdown = htmlToMarkdown(contentHtml).trim()
    return markdown ? { markdown } : null
  } catch {
    return null // linkedom/Readability parse error — fall through to Tier 2
  }
}

// Tier 3 — Bright Data Web Unlocker (api.brightdata.com/request) for
// PerimeterX-protected hosts (StreetEasy). Pay-per-success (~$0.001/request).
//
// Bright Data's /request endpoint requires BOTH a Bearer API key AND a `zone`
// (the Web Unlocker zone name from the control panel). The zone is read from
// BRIGHTDATA_ZONE — if it's not set, Tier 3 cleanly returns null and logs why
// (no throw, no fake).
//
// NOTE: this zone returns EMPTY with `data_format: markdown` (verified), so we
// request raw HTML (`format: raw`) and convert to Markdown locally via turndown.
// Unlocking a PerimeterX host (StreetEasy) is slow — ~45-80s observed — hence
// the long timeout. PerimeterX hosts are a small fraction of all scrapes.
import { htmlToMarkdown } from './htmlToMarkdown'

const ENDPOINT = 'https://api.brightdata.com/request'
const TIMEOUT_MS = 90_000

export async function scrapeTier3(url: string): Promise<{ markdown: string } | null> {
  const apiKey = process.env.BRIGHTDATA_API_KEY
  const zone = process.env.BRIGHTDATA_ZONE
  if (!apiKey) {
    console.warn('[scrape:tier3] BRIGHTDATA_API_KEY not set — Tier 3 unavailable')
    return null
  }
  if (!zone) {
    console.warn('[scrape:tier3] BRIGHTDATA_ZONE not set — Tier 3 (PerimeterX hosts, e.g. StreetEasy) unavailable until the Web Unlocker zone name is configured')
    return null
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(ENDPOINT, {
      method:  'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ zone, url, format: 'raw' }),
      signal:  ctrl.signal,
    })
    if (!res.ok) {
      console.warn(`[scrape:tier3] Bright Data ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return null
    }
    const text = (await res.text()).trim()
    if (!text) return null
    // If the data_format hint was ignored and we got HTML, convert locally.
    const looksHtml = /^\s*<(?:!doctype|html|head|body|div|p|a|section|article|main|span)/i.test(text)
    const markdown = (looksHtml ? htmlToMarkdown(text) : text).trim()
    return markdown ? { markdown } : null
  } catch (e) {
    console.warn(`[scrape:tier3] error: ${(e as Error).message}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

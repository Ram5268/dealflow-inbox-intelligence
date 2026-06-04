// Phase 4.1 — tiered scrape waterfall, replacing Firecrawl.
//   T1 fetch + Readability + linkedom + turndown  (free, ~95% of URLs)
//   T2 Jina AI Reader fallback                     (free tier)
//   T3 Bright Data Web Unlocker                    (PerimeterX hosts only, paid)
// Returns null when every applicable tier fails — the caller logs + skips.
import { scrapeTier1 } from './tier1Fetch'
import { scrapeTier2 } from './tier2Jina'
import { scrapeTier3 } from './tier3BrightData'

export interface ScrapeResult {
  markdown:         string
  detectedFileUrls: string[]
  tier:             1 | 2 | 3
}

// Hosts behind PerimeterX (bot protection) that T1/T2 can't get past — go
// straight to Tier 3. Expand as more are discovered.
const PERIMETERX_HOSTS: RegExp[] = [/streeteasy\.com$/i]

// Detect downloadable file URLs in the Markdown (ported verbatim from the old
// Firecrawl wrapper) so the pipeline can treat them as LinkedResources.
function extractFileUrls(markdown: string): string[] {
  const matches = markdown.match(/https?:\/\/[^\s)\]]+\.(pdf|docx?|xlsx?|jpe?g|png|webp)/gi) ?? []
  return [...new Set(matches)]
}

function finalize(markdown: string, tier: 1 | 2 | 3): ScrapeResult {
  return { markdown, detectedFileUrls: extractFileUrls(markdown), tier }
}

export async function scrapeUrl(url: string): Promise<ScrapeResult | null> {
  let host: string
  try { host = new URL(url).hostname } catch { return null }

  // PerimeterX-protected → Tier 3 directly (T1/T2 would just 403).
  if (PERIMETERX_HOSTS.some(re => re.test(host))) {
    const t3 = await scrapeTier3(url).catch(() => null)
    return t3 ? finalize(t3.markdown, 3) : null
  }

  const t1 = await scrapeTier1(url).catch(() => null)
  if (t1 && t1.markdown.length > 500) return finalize(t1.markdown, 1)

  const t2 = await scrapeTier2(url).catch(() => null)
  if (t2 && t2.markdown.length > 200) return finalize(t2.markdown, 2)

  return null
}

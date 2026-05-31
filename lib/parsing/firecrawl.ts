import FirecrawlApp from '@mendable/firecrawl-js'

// Firecrawl wrapper. Given any URL, returns clean Markdown + detected file
// links (PDFs, images, Office docs found on the page) so the ingestion
// pipeline can recursively crawl deeper resources from one initial link.
export interface ScrapedUrl {
  url:              string
  markdown:         string
  title:            string | null
  description:      string | null
  detectedFileUrls: string[]
}

let cachedClient: FirecrawlApp | null = null

function getClient(): FirecrawlApp {
  if (cachedClient) return cachedClient
  const apiKey = process.env.FIRECRAWL_API_KEY
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY must be set in env.')
  cachedClient = new FirecrawlApp({ apiKey })
  return cachedClient
}

// Detect downloadable file URLs embedded in the Markdown — these become
// LinkedResource downloads in Phase 3 (treated as attachments).
function extractFileUrls(markdown: string): string[] {
  const matches = markdown.match(/https?:\/\/[^\s)\]]+\.(pdf|docx?|xlsx?|jpe?g|png|webp)/gi) ?? []
  return [...new Set(matches)]
}

export async function scrapeUrl(url: string): Promise<ScrapedUrl> {
  const client = getClient()
  // SDK return shape varies across versions; defensive access.
  const raw = await client.scrapeUrl(url, {
    formats: ['markdown'],
    onlyMainContent: true,
    waitFor: 1000,
  }) as unknown as Record<string, unknown>

  if (raw.success === false) {
    throw new Error(`Firecrawl scrape failed: ${String(raw.error ?? 'unknown')}`)
  }

  const data     = (raw.data ?? raw) as Record<string, unknown>
  const markdown = String(data.markdown ?? '')
  const metadata = (data.metadata ?? {}) as Record<string, unknown>

  return {
    url,
    markdown,
    title:            (metadata.title       as string | undefined) ?? null,
    description:      (metadata.description as string | undefined) ?? null,
    detectedFileUrls: extractFileUrls(markdown),
  }
}

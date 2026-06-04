// Tier 2 — Jina AI Reader (https://r.jina.ai/<url>). Returns clean Markdown
// directly. Free tier works without a key (rate-limited); JINA_API_KEY raises
// the limit if set. On 429, retry once after 30s (per the Phase 4 decision
// tree). Returns null on failure so the waterfall ends cleanly.
const TIMEOUT_MS = 20_000

async function fetchJina(url: string): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'X-Return-Format': 'markdown' }
    if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`
    // Jina Reader takes the raw target URL appended to its host.
    return await fetch(`https://r.jina.ai/${url}`, { headers, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

export async function scrapeTier2(url: string): Promise<{ markdown: string } | null> {
  try {
    let res = await fetchJina(url)
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 30_000))
      res = await fetchJina(url)
    }
    if (!res.ok) return null
    const markdown = (await res.text()).trim()
    return markdown ? { markdown } : null
  } catch {
    return null
  }
}

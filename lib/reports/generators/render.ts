// Brief 27.0 — markdown renderer + source collector, shared by every generator.
// The rendered markdown is what the modal's Copy button emits (Phase 1b) and what
// we persist on the Report row.
import type { SectionResult, SourceRef } from './types'

function renderMetrics(metrics: NonNullable<SectionResult['content']['metrics']>): string {
  if (!metrics.length) return ''
  const rows = metrics.map(m => `| ${m.label} | ${m.value} | ${m.source ?? ''} |`).join('\n')
  return `\n| Metric | Value | Source |\n|---|---|---|\n${rows}\n`
}

function renderItems(items: NonNullable<SectionResult['content']['items']>): string {
  if (!items.length) return ''
  return items
    .map(it => {
      // Prefer a readable one-liner; fall back to compact JSON of the item.
      const addr = it.address ?? it.listingId ?? ''
      const price = it.priceLabel ?? ''
      const detail = it.fit ?? it.why ?? it.expected ?? ''
      const line = [addr, price, detail].filter(Boolean).join(' — ')
      return `- ${line || JSON.stringify(it)}`
    })
    .join('\n')
}

export function renderMarkdown(sections: SectionResult[], opts?: { title?: string; subtitle?: string }): string {
  const parts: string[] = []
  if (opts?.title) parts.push(`# ${opts.title}`)
  if (opts?.subtitle) parts.push(`_${opts.subtitle}_`)

  sections.forEach((s, i) => {
    parts.push(`## ${String(i + 1).padStart(2, '0')}. ${s.title}`)
    if (s.content.prose) parts.push(s.content.prose)
    const items = renderItems(s.content.items ?? [])
    if (items) parts.push(items)
    const metrics = renderMetrics(s.content.metrics ?? [])
    if (metrics) parts.push(metrics.trim())
  })

  return parts.join('\n\n').trim() + '\n'
}

// Dedup by type + id (an undefined id dedups per-type). Order preserved.
export function collectSources(sections: SectionResult[]): SourceRef[] {
  const seen = new Set<string>()
  const out: SourceRef[] = []
  for (const s of sections) {
    for (const src of s.sources) {
      const key = `${src.type}::${src.id ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(src)
    }
  }
  return out
}

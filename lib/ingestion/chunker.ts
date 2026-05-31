import type { ChunkType } from '../embeddings/dispatcher'
import type { ParsedPdfPage } from '../parsing/llamaParse'
import type { ScrapedUrl } from '../parsing/firecrawl'

// Chunk shape consumed by Phase 3B's ingestion orchestrator. The orchestrator
// embeds via the dispatcher (which routes text vs multimodal), upserts to
// Qdrant under the right collection, and persists a DocumentChunk row.
export interface Chunk {
  chunkType:       ChunkType
  content:         string
  pageNumber?:     number
  sectionHeading?: string
  hasTable?:       boolean
  hasImage?:       boolean
  tokenCount:      number
  imageBase64?:    string                            // multimodal only
  imageMimeType?:  string                            // multimodal only
}

const TARGET_TOKENS  = 512
const OVERLAP_TOKENS = 50

// Rough token estimate for English text. Voyage 3-large accepts 32K tokens
// per input, so this only needs to be roughly right for chunk-size targeting.
// 1 English token ≈ 4 characters is the standard heuristic.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function takeLastTokens(text: string, tokens: number): string {
  const targetChars = tokens * 4
  if (text.length <= targetChars) return text
  let start = text.length - targetChars
  while (start < text.length && /\S/.test(text[start])) start++  // snap to word boundary
  return text.slice(start).trimStart()
}

// ── Email body chunker ──────────────────────────────────────────────────────
// Paragraph-aware semantic chunking. ~512 tokens per chunk with 50-token
// overlap so context isn't lost at chunk boundaries.
export function chunkEmailBody(body: string): Chunk[] {
  return chunkPlainText(body, 'email_body')
}

// ── Linked-HTML chunker (consumes Firecrawl output) ─────────────────────────
// Section-aware: split on top-level Markdown headings first, then paragraph-
// chunk within each section. Each chunk records the section heading so
// retrieval can scope queries like "what does the Financials section say."
export function chunkLinkedHtml(scraped: ScrapedUrl): Chunk[] {
  const md = scraped.markdown.trim()
  if (!md) return []

  // Split on top-level headings, preserving the heading as part of each section.
  const sections = md.split(/(?=^#\s+)/gm).filter(s => s.trim())
  const chunks: Chunk[] = []

  for (const section of sections) {
    const headingMatch = section.match(/^#+\s+(.+?)(?:\n|$)/)
    const heading = headingMatch?.[1]?.trim()
    const sectionChunks = chunkPlainText(section, 'linked_html')
    for (const c of sectionChunks) {
      if (heading) c.sectionHeading = heading
    }
    chunks.push(...sectionChunks)
  }
  return chunks
}

// ── PDF text chunker (one page → potentially multiple chunks) ───────────────
// Each chunk inherits the page number so citation rendering can hyperlink
// back to the exact page. hasTable / hasImage flags propagate so retrieval
// can boost "page with rent roll table" queries.
export function chunkPdfPage(page: ParsedPdfPage): Chunk[] {
  if (!page.markdown.trim()) return []
  const chunks = chunkPlainText(page.markdown, 'pdf_text')
  return chunks.map(c => ({
    ...c,
    pageNumber: page.pageNumber,
    hasTable:   page.tableCount > 0,
    hasImage:   page.imageCount > 0,
  }))
}

// ── Table chunker (whole table = one chunk) ─────────────────────────────────
// Splitting a rent roll across chunks loses row/column structure, so the
// whole table is one unit. Large rent rolls (50+ rows) still fit in a single
// chunk well under the 32K input ceiling.
export function chunkPdfTable(tableMarkdown: string, pageNumber: number, sectionHeading?: string): Chunk {
  return {
    chunkType:      'pdf_table',
    content:        tableMarkdown,
    pageNumber,
    sectionHeading,
    hasTable:       true,
    tokenCount:     estimateTokens(tableMarkdown),
  }
}

// ── Image chunker (PDF page images, inline email images, attached images) ──
// Image chunks carry BOTH the caption (text-side retrieval) AND the base64
// bytes (multimodal embedding). The dispatcher routes to multimodal collection
// automatically based on chunkType.
export interface ImageChunkInput {
  chunkType:     'pdf_image' | 'inline_image' | 'image_attachment'
  caption:       string
  imageBase64:   string
  imageMimeType: string
  pageNumber?:   number
}

export function chunkImage(input: ImageChunkInput): Chunk {
  return {
    chunkType:     input.chunkType,
    content:       input.caption,
    pageNumber:    input.pageNumber,
    hasImage:      true,
    tokenCount:    estimateTokens(input.caption),
    imageBase64:   input.imageBase64,
    imageMimeType: input.imageMimeType,
  }
}

// ── Core plain-text chunker (paragraph-aware with overlap) ──────────────────
// Used by email body, linked HTML sections, and PDF page text. Accumulates
// paragraphs until target token count; on overflow, starts a new chunk with
// the last 50-ish tokens of the previous chunk as context.
function chunkPlainText(text: string, chunkType: ChunkType): Chunk[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const paragraphs = trimmed.split(/\n\n+/).map(p => p.trim()).filter(Boolean)
  const chunks: Chunk[] = []
  let current = ''
  let currentTokens = 0

  function flush() {
    if (current.trim()) {
      chunks.push({
        chunkType,
        content:    current.trim(),
        tokenCount: currentTokens,
      })
    }
  }

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para)

    // Single paragraph exceeds target → fall back to sentence-level splitting.
    if (paraTokens > TARGET_TOKENS) {
      flush()
      current = ''
      currentTokens = 0
      const sentences = para.split(/(?<=[.!?])\s+/)
      for (const sent of sentences) {
        const sentTokens = estimateTokens(sent)
        if (currentTokens + sentTokens > TARGET_TOKENS && current) {
          flush()
          const overlap = takeLastTokens(current, OVERLAP_TOKENS)
          current = overlap ? `${overlap} ${sent}` : sent
          currentTokens = estimateTokens(current)
        } else {
          current = current ? `${current} ${sent}` : sent
          currentTokens += sentTokens + 1
        }
      }
      continue
    }

    if (currentTokens + paraTokens > TARGET_TOKENS && current) {
      flush()
      const overlap = takeLastTokens(current, OVERLAP_TOKENS)
      current = overlap ? `${overlap}\n\n${para}` : para
      currentTokens = estimateTokens(current)
    } else {
      current = current ? `${current}\n\n${para}` : para
      currentTokens += paraTokens + (current === para ? 0 : 1)
    }
  }
  flush()
  return chunks
}

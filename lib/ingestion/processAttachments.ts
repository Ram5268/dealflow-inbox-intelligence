import { randomUUID } from 'crypto'
import { prisma } from '../prisma'
import { captionImage } from '../parsing/imageCaption'
import { embedChunk } from '../embeddings/dispatcher'
import { upsertChunk, type ChunkPayload } from '../vectorstore/qdrant'
import { chunkImage, chunkPdfPage, type Chunk } from './chunker'
import { parsePdf } from '../parsing/llamaParse'

// Phase 3D — Processes Attachment rows whose bytes were cached at sync time.
// Routes PDFs through LlamaParse Premium (per-page text + table fidelity) and
// image attachments through Claude vision + Voyage multimodal. DOCX/XLSX are
// recognised and explicitly deferred to Phase 3D.2.
//
// Idempotency: V2's deleteExistingChunks() wipes DocumentChunk rows for
// (emailId, organizationId) at the top of each ingestEmailV2 run, so this
// module always starts from a clean slate per email.

const MAX_ATTACHMENTS_PER_EMAIL       = 10
const MAX_IMAGE_ATTACHMENTS_PER_EMAIL = 5
const MAX_PDF_BYTES                   = 30 * 1024 * 1024   // 30MB cost guard
const MAX_PDF_PAGES                   = 100                // truncate huge brochures
const MIN_IMAGE_BYTES                 = 1024               // skip tracking pixels

type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
const SUPPORTED_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
])

// MIME prefixes we recognise but defer to a later phase.
const DEFERRED_MIME_PREFIXES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml',  // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml',     // .xlsx
  'application/vnd.openxmlformats-officedocument.presentationml',    // .pptx
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
] as const

export interface ProcessAttachmentsResult {
  attachmentsProcessed: number
  attachmentsSkipped:   number
  chunksCreated:        number
  byType:               Record<string, number>
  errors:               string[]
}

interface AttachmentRow {
  id:           string
  name:         string
  mimeType:     string
  sizeBytes:    number | null
  contentBytes: Uint8Array | null
}

interface Context {
  rawEmailId:     string
  threadId:       string | null
  organizationId: string
}

export async function processAttachments(args: {
  rawEmailId:     string
  threadId:       string | null
  organizationId: string
}): Promise<ProcessAttachmentsResult> {
  const errors: string[] = []
  const byType: Record<string, number> = {}
  let attachmentsProcessed = 0
  let attachmentsSkipped   = 0
  let chunksCreated        = 0

  const candidates = await prisma.attachment.findMany({
    where: {
      organizationId: args.organizationId,
      rawEmailId:     args.rawEmailId,
      contentBytes:   { not: null },
    },
    select: {
      id: true, name: true, mimeType: true, sizeBytes: true, contentBytes: true,
    },
    take: MAX_ATTACHMENTS_PER_EMAIL,
  })

  let imageBudget = MAX_IMAGE_ATTACHMENTS_PER_EMAIL
  const ctx: Context = {
    rawEmailId:     args.rawEmailId,
    threadId:       args.threadId,
    organizationId: args.organizationId,
  }

  for (const att of candidates as AttachmentRow[]) {
    const mime = (att.mimeType ?? '').toLowerCase()
    try {
      if (mime === 'application/pdf') {
        const { chunks: produced, error } = await handlePdfAttachment(att, ctx)
        if (error) errors.push(error)
        if (produced > 0) {
          attachmentsProcessed++
          chunksCreated += produced
        } else {
          attachmentsSkipped++
        }
      } else if (isImageMime(mime)) {
        if (imageBudget <= 0) {
          attachmentsSkipped++
          continue
        }
        const { ok, error } = await handleImageAttachment(att, ctx, mime as SupportedImageMime)
        if (error) errors.push(error)
        if (ok) {
          attachmentsProcessed++
          chunksCreated++
          imageBudget--
          byType['image_attachment'] = (byType['image_attachment'] ?? 0) + 1
        } else {
          attachmentsSkipped++
        }
      } else if (isDeferredMime(mime)) {
        // DOCX/XLSX/PPT — Phase 3D.2 will pick these up.
        console.log(`[processAttachments] deferred ${att.name} (${mime})`)
        attachmentsSkipped++
      } else {
        console.log(`[processAttachments] skip unsupported ${att.name} (${mime})`)
        attachmentsSkipped++
      }
    } catch (e) {
      errors.push(`attachment ${att.name}: ${(e as Error).message}`)
      attachmentsSkipped++
    }
  }

  // Roll PDF chunk types into byType by reading what we just inserted.
  // (Handlers persist directly; we recount instead of threading return data.)
  if (attachmentsProcessed > 0) {
    const justInserted = await prisma.documentChunk.groupBy({
      by:    ['chunkType'],
      where: {
        organizationId: args.organizationId,
        parentEmailId:  args.rawEmailId,
        chunkType:      { in: ['pdf_text', 'pdf_table', 'image_attachment'] },
      },
      _count: { chunkType: true },
    })
    for (const row of justInserted) {
      byType[row.chunkType] = row._count.chunkType
    }
  }

  return { attachmentsProcessed, attachmentsSkipped, chunksCreated, byType, errors }
}

// ── PDF handler ─────────────────────────────────────────────────────────────
async function handlePdfAttachment(
  att: AttachmentRow,
  ctx: Context,
): Promise<{ chunks: number; error?: string }> {
  if (!att.contentBytes) return { chunks: 0, error: `pdf ${att.name}: no bytes` }
  if (att.sizeBytes !== null && att.sizeBytes > MAX_PDF_BYTES) {
    return { chunks: 0, error: `pdf ${att.name}: too large (${att.sizeBytes} bytes)` }
  }

  let parsed
  try {
    // parsePdf expects a Buffer; Prisma returns the bytes as Uint8Array.
    // Buffer.from(uint8) reuses the backing memory — no copy.
    parsed = await parsePdf(Buffer.from(att.contentBytes), att.name)
  } catch (e) {
    return { chunks: 0, error: `parsePdf ${att.name}: ${(e as Error).message}` }
  }

  const pages = parsed.pages.slice(0, MAX_PDF_PAGES)
  if (parsed.pages.length > MAX_PDF_PAGES) {
    console.log(`[processAttachments] ${att.name}: truncated ${parsed.pages.length} → ${MAX_PDF_PAGES} pages`)
  }
  if (pages.length === 0) {
    return { chunks: 0, error: `pdf ${att.name}: 0 pages` }
  }

  let inserted = 0
  for (const page of pages) {
    const pageChunks = chunkPdfPage(page)
    for (const chunk of pageChunks) {
      try {
        await persistTextChunk(chunk, att, ctx)
        inserted++
      } catch (e) {
        console.error(`[processAttachments] persist page ${page.pageNumber} of ${att.name} failed:`, (e as Error).message)
      }
    }
  }

  // Record parsing metadata back on the Attachment row so subsequent re-runs
  // can short-circuit. Best-effort — failure here is non-fatal.
  await prisma.attachment.update({
    where: { id: att.id },
    data:  {
      llamaParseJobId: parsed.jobId,
      parseProvider:   'llamaparse',
    },
  }).catch(() => {})

  return { chunks: inserted }
}

// ── Image attachment handler ────────────────────────────────────────────────
async function handleImageAttachment(
  att: AttachmentRow,
  ctx: Context,
  mimeType: SupportedImageMime,
): Promise<{ ok: boolean; error?: string }> {
  if (!att.contentBytes) return { ok: false, error: `image ${att.name}: no bytes` }
  if (att.contentBytes.length < MIN_IMAGE_BYTES) {
    return { ok: false, error: `image ${att.name}: tracking pixel (${att.contentBytes.length} bytes)` }
  }

  // Prisma returns Bytes as Uint8Array; wrap in Buffer for the base64 encoder.
  const imageBase64 = Buffer.from(att.contentBytes).toString('base64')

  let caption: string
  try {
    caption = await captionImage(imageBase64, mimeType)
  } catch (e) {
    return { ok: false, error: `caption ${att.name}: ${(e as Error).message}` }
  }
  if (!caption || /^NONE/.test(caption)) {
    return { ok: false }
  }

  const chunk = chunkImage({
    chunkType:     'image_attachment',
    caption,
    imageBase64,
    imageMimeType: mimeType,
  })

  try {
    await persistImageChunk(chunk, att, ctx)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `persist image ${att.name}: ${(e as Error).message}` }
  }
}

// ── Persistence helpers ─────────────────────────────────────────────────────
async function persistTextChunk(chunk: Chunk, att: AttachmentRow, ctx: Context): Promise<void> {
  const embedded = await embedChunk({
    chunkType:   chunk.chunkType,
    textContent: chunk.content,
  })

  const chunkId = randomUUID()
  const payload: ChunkPayload = {
    tenant_id:            ctx.organizationId,
    chunk_id:             chunkId,
    parent_email_id:      ctx.rawEmailId,
    parent_attachment_id: att.id,
    thread_id:            ctx.threadId,
    chunk_type:           chunk.chunkType,
    page_number:          chunk.pageNumber ?? null,
    section_heading:      chunk.sectionHeading ?? null,
    has_table:            chunk.hasTable ?? false,
    has_image:            chunk.hasImage ?? false,
    embedding_model:      embedded.model,
    embedding_version:    embedded.embeddingVersion,
    created_at:           new Date().toISOString(),
  }

  await upsertChunk(embedded.collection, {
    id:     chunkId,
    vector: embedded.vector,
    payload,
  })

  await prisma.documentChunk.create({
    data: {
      id:                 chunkId,
      organizationId:     ctx.organizationId,
      parentEmailId:      ctx.rawEmailId,
      parentAttachmentId: att.id,
      threadId:           ctx.threadId,
      chunkType:          chunk.chunkType,
      content:            chunk.content,
      pageNumber:         chunk.pageNumber ?? null,
      sectionHeading:     chunk.sectionHeading ?? null,
      hasTable:           chunk.hasTable ?? false,
      hasImage:           chunk.hasImage ?? false,
      tokenCount:         chunk.tokenCount,
      embeddingModel:     embedded.model,
      embeddingVersion:   embedded.embeddingVersion,
      embeddedAt:         new Date(),
      qdrantPointId:      chunkId,
    },
  })
}

async function persistImageChunk(chunk: Chunk, att: AttachmentRow, ctx: Context): Promise<void> {
  const embedded = await embedChunk({
    chunkType:     chunk.chunkType,
    textContent:   chunk.content,
    imageBase64:   chunk.imageBase64,
    imageMimeType: chunk.imageMimeType,
  })

  const chunkId = randomUUID()
  const payload: ChunkPayload = {
    tenant_id:            ctx.organizationId,
    chunk_id:             chunkId,
    parent_email_id:      ctx.rawEmailId,
    parent_attachment_id: att.id,
    thread_id:            ctx.threadId,
    chunk_type:           chunk.chunkType,
    has_image:            true,
    embedding_model:      embedded.model,
    embedding_version:    embedded.embeddingVersion,
    created_at:           new Date().toISOString(),
  }

  await upsertChunk(embedded.collection, {
    id:     chunkId,
    vector: embedded.vector,
    payload,
  })

  await prisma.documentChunk.create({
    data: {
      id:                 chunkId,
      organizationId:     ctx.organizationId,
      parentEmailId:      ctx.rawEmailId,
      parentAttachmentId: att.id,
      threadId:           ctx.threadId,
      chunkType:          chunk.chunkType,
      content:            chunk.content,
      hasImage:           true,
      tokenCount:         chunk.tokenCount,
      embeddingModel:     embedded.model,
      embeddingVersion:   embedded.embeddingVersion,
      embeddedAt:         new Date(),
      qdrantPointId:      chunkId,
    },
  })
}

// ── MIME helpers ────────────────────────────────────────────────────────────
function isImageMime(mime: string): boolean {
  return SUPPORTED_IMAGE_MIMES.has(mime)
}

function isDeferredMime(mime: string): boolean {
  return DEFERRED_MIME_PREFIXES.some(p => mime.startsWith(p))
}

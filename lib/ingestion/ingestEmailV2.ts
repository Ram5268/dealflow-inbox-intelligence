import { randomUUID } from 'crypto'
import { prisma } from '../prisma'
import { getCurrentOrgId } from '../auth/orgContext'
import {
  type Chunk,
  chunkEmailBody,
  chunkLinkedHtml,
} from './chunker'
import {
  extractLinks,
  filterScrapeWorthyLinks,
} from '../parsing/linkExtractor'
import { scrapeUrl } from '../scraping/scrapeUrl'
import { embedChunk } from '../embeddings/dispatcher'
import {
  upsertChunk,
  deleteChunks,
  COLLECTIONS,
  type ChunkPayload,
} from '../vectorstore/qdrant'
import { processInlineImages } from './processImages'
import { processAttachments } from './processAttachments'
import { extractEmailV2 } from '../extraction/extractEmailV2'
import { sourceClassifier, buildIdempotencyKey } from './sourceClassifier'
import { logClassifier } from './costLogger'
import { PROMPT_VERSION } from './types'
import { isTestModeOnly } from '../config/testMode'
import { isIngestionTestModeOnly } from '../config/ingestionTestMode'

// Phase 3B orchestrator. Converts a RawEmail into DocumentChunk rows +
// Qdrant vectors. Idempotent — re-running on the same email deletes prior
// chunks before re-creating. Attachments and inline images are deferred to
// Phase 3C. Non-HTML links (PDF, Dropbox, Drive) are recorded as
// LinkedResource with fetchStatus 'deferred'. The scrape filter keeps
// per-email scrape usage bounded.

export interface IngestV2Result {
  emailId:         string
  threadId:        string
  chunksCreated:   number
  byType:          Record<string, number>
  linksFound:      number
  linksScraped:    number
  linksDeferred:   number
  linksFiltered:   number
  imagesProcessed:      number
  imagesSkipped:        number
  attachmentsProcessed: number    // NEW (Phase 3D)
  attachmentsSkipped:   number    // NEW (Phase 3D)
  errors:               string[]
}

interface PendingChunk {
  chunk:      Chunk
  parentType: 'email' | 'linked'
  parentId:   string
}

export async function ingestEmailV2(emailId: string): Promise<IngestV2Result> {
  // Brief 5.0 / 6.0 — entry gate. No real email is ingested when either the chat
  // seed-only mode (TEST_MODE_ONLY) or the ingestion isolation mode
  // (INGESTION_TEST_MODE_ONLY) is on. Returns a well-formed zero-result
  // (IngestV2Result has no dedicated skip field).
  if (isTestModeOnly() || isIngestionTestModeOnly()) {
    const flag = isIngestionTestModeOnly() ? 'INGESTION_TEST_MODE_ONLY' : 'TEST_MODE_ONLY'
    console.log(`[ingest v2] skipped: ${flag} is on`)
    return {
      emailId, threadId: '', chunksCreated: 0, byType: {},
      linksFound: 0, linksScraped: 0, linksDeferred: 0, linksFiltered: 0,
      imagesProcessed: 0, imagesSkipped: 0,
      attachmentsProcessed: 0, attachmentsSkipped: 0,
      errors: [`skipped: ${flag} is on`],
    }
  }

  const organizationId = await getCurrentOrgId()

  const email = await prisma.rawEmail.findUnique({
    where:  { id: emailId },
    select: {
      id: true, subject: true, senderName: true, senderEmail: true,
      receivedDateTime: true, bodyContent: true, bodyPreview: true,
      bodyContentType: true, rawJson: true, graphMessageId: true,
      threadId: true, classifierCategory: true,
    },
  })
  if (!email) throw new Error(`RawEmail ${emailId} not found`)

  // 1. Resolve thread
  const thread = await resolveThread(email, organizationId)
  if (email.threadId !== thread.id) {
    await prisma.rawEmail.update({ where: { id: emailId }, data: { threadId: thread.id } })
  }

  // 2. Idempotency wipe
  await deleteExistingChunks(emailId, organizationId)

  const errors: string[] = []
  const pending: PendingChunk[] = []

  // 3. Body chunks. bodyContent is already HTML-stripped by backgroundSync
  // at sync time; stripHtml here is a defensive double-pass (no-op on already-
  // stripped text).
  const bodyText = stripHtml(email.bodyContent ?? email.bodyPreview ?? '')
  for (const chunk of chunkEmailBody(bodyText)) {
    pending.push({ chunk, parentType: 'email', parentId: emailId })
  }

  // 4. Link extraction. bodyContent has been pre-stripped at sync time so
  // href= URLs are gone. rawJson preserves the verbatim Graph payload —
  // extract links from rawJson.body.content with a fallback to bodyText for
  // any legacy records lacking rawJson.
  const rawHtmlBody = extractRawHtmlBody(email.rawJson) ?? bodyText
  const allLinks    = extractLinks(rawHtmlBody)
  const { scrape, deferred, filtered } = filterScrapeWorthyLinks(allLinks)
  let linksScraped = 0

  // Record deferred (non-HTML) links — Phase 3C will pick them up
  for (const link of deferred) {
    try {
      await prisma.linkedResource.create({
        data: {
          organizationId,
          parentEmailId: emailId,
          url:           link.url,
          resourceType:  link.type,
          fetchStatus:   'deferred',
          fetchError:    `type ${link.type} deferred to Phase 3C`,
        },
      })
    } catch (e) {
      errors.push(`record deferred ${link.url}: ${(e as Error).message}`)
    }
  }

  // Scrape filtered HTML links via the tiered waterfall (Phase 4.1).
  for (const link of scrape) {
    try {
      const resource = await prisma.linkedResource.create({
        data: {
          organizationId,
          parentEmailId: emailId,
          url:           link.url,
          resourceType:  'html',
          fetchStatus:   'pending',
        },
      })
      try {
        const scraped = await scrapeUrl(link.url)
        if (!scraped) {
          // Every applicable tier returned nothing — record + skip (non-fatal).
          await prisma.linkedResource.update({
            where: { id: resource.id },
            data:  { fetchStatus: 'failed', fetchError: 'all scrape tiers failed' },
          })
          errors.push(`scrape ${link.url}: all tiers failed`)
        } else {
          await prisma.linkedResource.update({
            where: { id: resource.id },
            data: {
              fetchStatus:    'fetched',
              fetchedAt:      new Date(),
              parsedMarkdown: scraped.markdown,
            },
          })
          for (const chunk of chunkLinkedHtml(scraped)) {
            pending.push({ chunk, parentType: 'linked', parentId: resource.id })
          }
          linksScraped++
        }
      } catch (e) {
        await prisma.linkedResource.update({
          where: { id: resource.id },
          data:  { fetchStatus: 'failed', fetchError: (e as Error).message },
        })
        errors.push(`scrape ${link.url}: ${(e as Error).message}`)
      }
    } catch (e) {
      errors.push(`record link ${link.url}: ${(e as Error).message}`)
    }
  }

  // 5. Embed + persist pending chunks
  let chunksCreated = 0
  const byType: Record<string, number> = {}

  for (const p of pending) {
    try {
      const embedded = await embedChunk({
        chunkType:     p.chunk.chunkType,
        textContent:   p.chunk.content,
        imageBase64:   p.chunk.imageBase64,
        imageMimeType: p.chunk.imageMimeType,
      })

      const chunkId = randomUUID()
      const payload: ChunkPayload = {
        tenant_id:         organizationId,
        chunk_id:          chunkId,
        parent_email_id:   emailId,
        thread_id:         thread.id,
        chunk_type:        p.chunk.chunkType,
        page_number:       p.chunk.pageNumber ?? null,
        section_heading:   p.chunk.sectionHeading ?? null,
        has_table:         p.chunk.hasTable ?? false,
        has_image:         p.chunk.hasImage ?? false,
        embedding_model:   embedded.model,
        embedding_version: embedded.embeddingVersion,
        created_at:        new Date().toISOString(),
        ...(p.parentType === 'linked' ? { parent_linked_resource_id: p.parentId } : {}),
      }

      await upsertChunk(embedded.collection, {
        id:     chunkId,
        vector: embedded.vector,
        payload,
      })

      await prisma.documentChunk.create({
        data: {
          id:                     chunkId,
          organizationId,
          parentEmailId:          emailId,
          parentLinkedResourceId: p.parentType === 'linked' ? p.parentId : null,
          threadId:               thread.id,
          chunkType:              p.chunk.chunkType,
          content:                p.chunk.content,
          pageNumber:             p.chunk.pageNumber ?? null,
          sectionHeading:         p.chunk.sectionHeading ?? null,
          hasTable:               p.chunk.hasTable ?? false,
          hasImage:               p.chunk.hasImage ?? false,
          tokenCount:             p.chunk.tokenCount,
          embeddingModel:         embedded.model,
          embeddingVersion:       embedded.embeddingVersion,
          embeddedAt:             new Date(),
          qdrantPointId:          chunkId,
        },
      })

      chunksCreated++
      byType[p.chunk.chunkType] = (byType[p.chunk.chunkType] ?? 0) + 1
    } catch (e) {
      errors.push(`embed/persist chunk: ${(e as Error).message}`)
    }
  }

  // 5b. Phase 3C — Process deferred inline images (image-type LinkedResources)
  let imagesProcessed = 0
  let imagesSkipped   = 0
  try {
    const imgResult = await processInlineImages({
      emailId,
      threadId: thread.id,
      organizationId,
    })
    imagesProcessed = imgResult.imagesProcessed
    imagesSkipped   = imgResult.imagesSkipped
    if (imgResult.imagesProcessed > 0) {
      chunksCreated += imgResult.imagesProcessed
      byType['inline_image'] = (byType['inline_image'] ?? 0) + imgResult.imagesProcessed
    }
    errors.push(...imgResult.errors)
  } catch (e) {
    errors.push(`processInlineImages: ${(e as Error).message}`)
  }

  // 5c. Phase 3D — Process Attachment rows (PDFs via LlamaParse + image
  // attachments via Claude vision). Bytes were cached at sync time so this
  // does not re-hit Microsoft Graph.
  let attachmentsProcessed = 0
  let attachmentsSkipped   = 0
  try {
    const attResult = await processAttachments({
      rawEmailId:     emailId,
      threadId:       thread.id,
      organizationId,
    })
    attachmentsProcessed = attResult.attachmentsProcessed
    attachmentsSkipped   = attResult.attachmentsSkipped
    chunksCreated       += attResult.chunksCreated
    for (const [type, count] of Object.entries(attResult.byType)) {
      byType[type] = (byType[type] ?? 0) + count
    }
    errors.push(...attResult.errors)
  } catch (e) {
    errors.push(`processAttachments: ${(e as Error).message}`)
  }

  // 6. Mark email as embedded
  await prisma.rawEmail.update({
    where: { id: emailId },
    data:  { embeddedAt: new Date() },
  })

  // 6b. Classifier (lifted from V1 in 2026-06-07 fix). When INGEST_V2=true
  // gated off V1, the classifier stopped running and extractEmailV2 silently
  // no-op'd because classifierCategory was null. We re-run it here, AFTER
  // chunking so a classifier failure cannot undo embedding work. Guarded by
  // `!email.classifierCategory` so re-runs are idempotent and pre-existing
  // tags (e.g. legacy HOTSHEET sentinel, V1 classifications) are preserved.
  let classifierCategory: string | null = email.classifierCategory ?? null
  let needsDeepExtract = true
  if (!email.classifierCategory) {
    try {
      const atts = await prisma.attachment.findMany({
        where: { organizationId, rawEmailId: emailId },
        select: { name: true, mimeType: true },
      })
      const classifierKey = buildIdempotencyKey(emailId, 'source_classifier', PROMPT_VERSION)
      const classifyStart = Date.now()
      const classified = await sourceClassifier({
        rawEmailId:          emailId,
        subject:             email.subject,
        senderName:          email.senderName,
        senderEmail:         email.senderEmail,
        bodyPreview:         email.bodyPreview,
        bodyFirst500:        bodyText ? bodyText.slice(0, 500) : null,
        attachmentNames:     atts.map(a => a.name),
        attachmentMimeTypes: atts.map(a => a.mimeType),
        attachmentCount:     atts.length,
      })
      classifierCategory = classified.category
      needsDeepExtract   = classified.needsDeepExtract
      await logClassifier(emailId, classifierKey, classified, Date.now() - classifyStart).catch(() => {})
      await prisma.rawEmail.update({
        where: { id: emailId },
        data: {
          classifierStatus:     'classified',
          classifierCategory:   classified.category,
          classifierConfidence: classified.confidence,
          extractionStatus:     classified.needsDeepExtract ? 'pending' : 'skipped',
          lastProcessedAt:      new Date(),
          idempotencyKey:       classifierKey,
        },
      }).catch(() => {})
      console.log(`[ingestV2] ${emailId}: classified as ${classified.category} (conf ${classified.confidence})`)
    } catch (e) {
      errors.push(`classifier: ${(e as Error).message}`)
    }
  }

  // 7. Phase 4.0 — V2 extraction. Reads the chunks just persisted and writes
  // clean ExtractedOpportunity rows (Sonnet tool_use). Idempotent + non-fatal:
  // a failure here must not undo the chunking/embedding work above.
  if (needsDeepExtract && classifierCategory) {
    try {
      const opps = await extractEmailV2(emailId, organizationId)
      console.log(`[ingestV2] ${emailId}: extracted ${opps.length} opportunities (${classifierCategory})`)
    } catch (e) {
      errors.push(`extractEmailV2: ${(e as Error).message}`)
    }
  } else {
    console.log(`[ingestV2] ${emailId}: classifier=${classifierCategory ?? 'null'} needsDeepExtract=${needsDeepExtract} — skipping extraction`)
  }

  return {
    emailId,
    threadId:      thread.id,
    chunksCreated,
    byType,
    linksFound:    allLinks.length,
    linksScraped,
    linksDeferred: deferred.length,
    linksFiltered: filtered,
    imagesProcessed,
    imagesSkipped,
    attachmentsProcessed,    // NEW (Phase 3D)
    attachmentsSkipped,      // NEW (Phase 3D)
    errors,
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface EmailForThread {
  graphMessageId:   string
  subject:          string
  senderEmail:      string | null
  senderName:       string | null
  receivedDateTime: Date
  rawJson:          unknown
}

async function resolveThread(email: EmailForThread, organizationId: string) {
  const conversationId =
    (typeof email.rawJson === 'object' && email.rawJson !== null && 'conversationId' in email.rawJson
      ? String((email.rawJson as Record<string, unknown>).conversationId)
      : null) ?? email.graphMessageId

  return prisma.emailThread.upsert({
    where: {
      organizationId_graphConversationId: {
        organizationId,
        graphConversationId: conversationId,
      },
    },
    update: {
      lastMessageAt: email.receivedDateTime,
      messageCount:  { increment: 1 },
    },
    create: {
      organizationId,
      graphConversationId: conversationId,
      subjectRoot:         email.subject.replace(/^(Re|Fwd?):\s*/gi, '').trim(),
      participants:        email.senderEmail ? [email.senderEmail] : [],
      firstMessageAt:      email.receivedDateTime,
      lastMessageAt:       email.receivedDateTime,
      messageCount:        1,
    },
  })
}

async function deleteExistingChunks(emailId: string, organizationId: string) {
  const existing = await prisma.documentChunk.findMany({
    where:  { organizationId, parentEmailId: emailId },
    select: { id: true },
  })
  if (existing.length === 0) {
    // Still clear linked resources for idempotent re-runs.
    await prisma.linkedResource.deleteMany({
      where: { organizationId, parentEmailId: emailId },
    })
    return
  }
  const ids = existing.map(c => c.id)
  await deleteChunks(COLLECTIONS.text,       ids).catch(() => {})
  await deleteChunks(COLLECTIONS.multimodal, ids).catch(() => {})
  await prisma.documentChunk.deleteMany({
    where: { organizationId, parentEmailId: emailId },
  })
  await prisma.linkedResource.deleteMany({
    where: { organizationId, parentEmailId: emailId },
  })
}

function stripHtml(html: string): string {
  if (!html) return ''
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|h[1-6])[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Returns the original raw HTML body from the verbatim Graph payload, if
// available. RawEmail.bodyContent is already stripped by backgroundSync at
// sync time, so href= URLs are lost from it. rawJson preserves the original.
function extractRawHtmlBody(rawJson: unknown): string | null {
  if (!rawJson || typeof rawJson !== 'object') return null
  const obj  = rawJson as Record<string, unknown>
  const body = obj.body
  if (!body || typeof body !== 'object') return null
  const content = (body as Record<string, unknown>).content
  return typeof content === 'string' && content.length > 0 ? content : null
}

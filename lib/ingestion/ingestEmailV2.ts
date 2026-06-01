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
import { scrapeUrl } from '../parsing/firecrawl'
import { embedChunk } from '../embeddings/dispatcher'
import {
  upsertChunk,
  deleteChunks,
  COLLECTIONS,
  type ChunkPayload,
} from '../vectorstore/qdrant'

// Phase 3B orchestrator. Converts a RawEmail into DocumentChunk rows +
// Qdrant vectors. Idempotent — re-running on the same email deletes prior
// chunks before re-creating. Attachments and inline images are deferred to
// Phase 3C. Non-HTML links (PDF, Dropbox, Drive) are recorded as
// LinkedResource with fetchStatus 'deferred'. The scrape filter keeps
// Firecrawl usage bounded.

export interface IngestV2Result {
  emailId:        string
  threadId:       string
  chunksCreated:  number
  byType:         Record<string, number>
  linksFound:     number    // total URLs in body
  linksScraped:   number    // URLs that passed the filter and were fetched
  linksDeferred:  number    // non-HTML URLs recorded but not fetched
  linksFiltered:  number    // HTML URLs dropped by the scrape filter
  errors:         string[]
}

interface PendingChunk {
  chunk:      Chunk
  parentType: 'email' | 'linked'
  parentId:   string
}

export async function ingestEmailV2(emailId: string): Promise<IngestV2Result> {
  const organizationId = await getCurrentOrgId()

  const email = await prisma.rawEmail.findUnique({
    where:  { id: emailId },
    select: {
      id: true, subject: true, senderName: true, senderEmail: true,
      receivedDateTime: true, bodyContent: true, bodyPreview: true,
      bodyContentType: true, rawJson: true, graphMessageId: true,
      threadId: true,
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

  // 3. Body chunks (text chunker needs HTML stripped)
  const rawBody  = email.bodyContent ?? email.bodyPreview ?? ''
  const bodyText = stripHtml(rawBody)
  for (const chunk of chunkEmailBody(bodyText)) {
    pending.push({ chunk, parentType: 'email', parentId: emailId })
  }

  // 4. Link handling — extract from RAW body (HTML strip kills href= URLs)
  const allLinks = extractLinks(rawBody)
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

  // Scrape filtered HTML links via Firecrawl
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

  // 6. Mark email as embedded
  await prisma.rawEmail.update({
    where: { id: emailId },
    data:  { embeddedAt: new Date() },
  })

  return {
    emailId,
    threadId:      thread.id,
    chunksCreated,
    byType,
    linksFound:    allLinks.length,
    linksScraped,
    linksDeferred: deferred.length,
    linksFiltered: filtered,
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

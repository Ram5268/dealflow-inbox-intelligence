import { randomUUID } from 'crypto'
import { prisma } from '../prisma'
import { captionImage } from '../parsing/imageCaption'
import { embedChunk } from '../embeddings/dispatcher'
import { upsertChunk, type ChunkPayload } from '../vectorstore/qdrant'
import { chunkImage } from './chunker'

// Phase 3C — Processes deferred image LinkedResource rows for an email.
// Fetches each image, validates it's real (not a tracking pixel), captions
// via Claude vision, embeds via Voyage multimodal, persists as DocumentChunk
// in the chunks_multimodal Qdrant collection.

const MAX_IMAGES_PER_EMAIL = 5      // cost cap: 5 × ~$0.005 = $0.025/email max
const MIN_IMAGE_BYTES      = 1024   // skip 1KB or smaller — likely tracking pixels

type SupportedMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
const SUPPORTED_MIMES: ReadonlySet<string> = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
])

// Email template chrome — social icons, branding, backgrounds, spacers.
// These consistently outrank real photos in raw insertion order, so we filter
// them out BEFORE applying MAX_IMAGES_PER_EMAIL.
const CHROME_PATH_PATTERNS: RegExp[] = [
  /\/templates?\//i,
  /\/icons?\//i,
  /\/blocks?-/i,
  /\/bg-/i,
  /\/banner/i,
  /\/divider/i,
  /\/spacer/i,
  /\/social/i,
  /agent-?bg/i,
  /home-?icon/i,
  /email-?template/i,
  /\/footer/i,
  /\/header/i,
  /-pixel\./i,
  /\/1x1\./i,
]

function isLikelyContentImage(url: string): boolean {
  try {
    const path = new URL(url).pathname
    return !CHROME_PATH_PATTERNS.some(rx => rx.test(path))
  } catch {
    return false
  }
}

// Hosts whose URLs require auth/signature context not available at sync replay
// time. Imgix-signed URLs (used by Rechat → Elliman, Serhant, and others)
// reliably 403 on GET hours after issuance. Skip entirely rather than burn
// requests failing.
const SKIP_HOSTS_FOR_REPLAY: ReadonlyArray<RegExp> = [
  /\.imgix\.net$/i,
]

function isReplayable(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return !SKIP_HOSTS_FOR_REPLAY.some(rx => rx.test(host))
  } catch {
    return false
  }
}

export interface ProcessImagesResult {
  imagesProcessed: number
  imagesSkipped:   number
  errors:          string[]
}

export async function processInlineImages(args: {
  emailId:        string
  threadId:       string
  organizationId: string
}): Promise<ProcessImagesResult> {
  const errors: string[] = []
  let imagesProcessed = 0
  let imagesSkipped   = 0

  // Fetch a larger candidate pool, filter out chrome, then apply the cap.
  // Without this, raw insertion order surfaces template assets (icons,
  // backgrounds) before real content images.
  const rawCandidates = await prisma.linkedResource.findMany({
    where: {
      organizationId: args.organizationId,
      parentEmailId:  args.emailId,
      resourceType:   'image',
      fetchStatus:    'deferred',
    },
    take: 50,
  })
  const candidates = rawCandidates
    .filter(r => isReplayable(r.url))            // skip imgix etc.
    .filter(r => isLikelyContentImage(r.url))     // skip template chrome
    .slice(0, MAX_IMAGES_PER_EMAIL)

  for (const resource of candidates) {
    try {
      // Direct GET — skip HEAD because some CDNs (notably imgix-signed URLs)
      // return 403 on HEAD. Validate content-type and size from the GET response.
      const res = await fetch(resource.url)
      if (!res.ok) {
        await markFailed(resource.id, `GET failed: ${res.status}`)
        errors.push(`fetch ${resource.url}: ${res.status}`)
        continue
      }
      const ctHdr = res.headers.get('content-type') ?? ''
      if (!ctHdr.startsWith('image/')) {
        await markFailed(resource.id, `not an image: ${ctHdr}`)
        imagesSkipped++
        continue
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      if (buffer.length < MIN_IMAGE_BYTES) {
        await markFailed(resource.id, `tracking pixel (${buffer.length} bytes)`)
        imagesSkipped++
        continue
      }
      const imageBase64 = buffer.toString('base64')
      const mimeType: SupportedMime = SUPPORTED_MIMES.has(ctHdr)
        ? (ctHdr as SupportedMime)
        : 'image/png'

      // Caption via Claude Sonnet vision
      const caption = await captionImage(imageBase64, mimeType)
      if (!caption || /^NONE/.test(caption)) {
        await markFailed(resource.id, 'no real estate content')
        imagesSkipped++
        continue
      }

      // Build chunk + multimodal embed
      const chunk = chunkImage({
        chunkType:     'inline_image',
        caption,
        imageBase64,
        imageMimeType: mimeType,
      })
      const embedded = await embedChunk({
        chunkType:     chunk.chunkType,
        textContent:   chunk.content,
        imageBase64:   chunk.imageBase64,
        imageMimeType: chunk.imageMimeType,
      })

      const chunkId = randomUUID()
      const payload: ChunkPayload = {
        tenant_id:                 args.organizationId,
        chunk_id:                  chunkId,
        parent_email_id:           args.emailId,
        parent_linked_resource_id: resource.id,
        thread_id:                 args.threadId,
        chunk_type:                chunk.chunkType,
        has_image:                 true,
        embedding_model:           embedded.model,
        embedding_version:         embedded.embeddingVersion,
        created_at:                new Date().toISOString(),
      }

      await upsertChunk(embedded.collection, {
        id:     chunkId,
        vector: embedded.vector,
        payload,
      })

      await prisma.documentChunk.create({
        data: {
          id:                     chunkId,
          organizationId:         args.organizationId,
          parentEmailId:          args.emailId,
          parentLinkedResourceId: resource.id,
          threadId:               args.threadId,
          chunkType:              chunk.chunkType,
          content:                chunk.content,
          hasImage:               true,
          tokenCount:             chunk.tokenCount,
          embeddingModel:         embedded.model,
          embeddingVersion:       embedded.embeddingVersion,
          embeddedAt:             new Date(),
          qdrantPointId:          chunkId,
        },
      })

      await prisma.linkedResource.update({
        where: { id: resource.id },
        data:  { fetchStatus: 'fetched', fetchedAt: new Date() },
      })

      imagesProcessed++
    } catch (e) {
      errors.push(`process ${resource.url}: ${(e as Error).message}`)
      await markFailed(resource.id, (e as Error).message).catch(() => {})
    }
  }

  return { imagesProcessed, imagesSkipped, errors }
}

async function markFailed(resourceId: string, reason: string) {
  await prisma.linkedResource.update({
    where: { id: resourceId },
    data:  { fetchStatus: 'failed', fetchError: reason.slice(0, 200) },
  })
}

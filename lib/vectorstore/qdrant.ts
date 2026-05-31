import { QdrantClient } from '@qdrant/js-client-rest'

// ── Constants ───────────────────────────────────────────────────────────────
// Two collections, one per modality. Both use 1024-dim Voyage embeddings.
// Text chunks (email body, PDF text, linked HTML, etc.) → chunks_text.
// Image chunks (PDF page images, inline images, attached images) → chunks_multimodal.
export const COLLECTIONS = {
  text:       'chunks_text',
  multimodal: 'chunks_multimodal',
} as const

export const VECTOR_DIM = 1024

// ── Payload schema ──────────────────────────────────────────────────────────
// Mirrors the DocumentChunk Prisma model so Qdrant queries are self-contained
// without round-trips to Postgres. tenant_id is indexed for fast scoping.
export interface ChunkPayload {
  tenant_id:                string
  chunk_id:                 string
  parent_email_id?:         string | null
  parent_attachment_id?:    string | null
  parent_linked_resource_id?: string | null
  thread_id?:               string | null
  chunk_type:               string
  page_number?:             number | null
  section_heading?:         string | null
  property_id?:             string | null
  has_table?:               boolean
  has_image?:               boolean
  embedding_model:          string
  embedding_version:        string
  created_at:               string
}

// ── Client ──────────────────────────────────────────────────────────────────
let cachedClient: QdrantClient | null = null

export function getQdrantClient(): QdrantClient {
  if (cachedClient) return cachedClient
  const url    = process.env.QDRANT_URL
  const apiKey = process.env.QDRANT_API_KEY
  if (!url || !apiKey) {
    throw new Error('QDRANT_URL and QDRANT_API_KEY must be set in env.')
  }
  cachedClient = new QdrantClient({ url, apiKey, checkCompatibility: false })
  return cachedClient
}

// ── Collection bootstrap (idempotent) ───────────────────────────────────────
// Creates the two collections + tenant_id payload index if they don't exist.
// Safe to call multiple times.
export async function ensureCollections(): Promise<void> {
  const client = getQdrantClient()
  const existing = await client.getCollections()
  const have = new Set(existing.collections.map(c => c.name))

  for (const name of Object.values(COLLECTIONS)) {
    if (!have.has(name)) {
      await client.createCollection(name, {
        vectors: { size: VECTOR_DIM, distance: 'Cosine' },
      })
      console.log(`[Qdrant] Created collection: ${name}`)
    } else {
      console.log(`[Qdrant] Collection exists: ${name}`)
    }

    // Idempotent — Qdrant ignores duplicate index creates.
    await client.createPayloadIndex(name, {
      field_name:   'tenant_id',
      field_schema: 'keyword',
    }).catch(() => {})
    await client.createPayloadIndex(name, {
      field_name:   'chunk_type',
      field_schema: 'keyword',
    }).catch(() => {})
    await client.createPayloadIndex(name, {
      field_name:   'parent_email_id',
      field_schema: 'keyword',
    }).catch(() => {})
    await client.createPayloadIndex(name, {
      field_name:   'thread_id',
      field_schema: 'keyword',
    }).catch(() => {})
    await client.createPayloadIndex(name, {
      field_name:   'property_id',
      field_schema: 'keyword',
    }).catch(() => {})
  }
}

// ── Upsert helper ───────────────────────────────────────────────────────────
export async function upsertChunk(
  collection: typeof COLLECTIONS[keyof typeof COLLECTIONS],
  point: { id: string; vector: number[]; payload: ChunkPayload }
): Promise<void> {
  const client = getQdrantClient()
  await client.upsert(collection, {
    points: [{ id: point.id, vector: point.vector, payload: point.payload as unknown as Record<string, unknown> }],
  })
}

// ── Search helper ───────────────────────────────────────────────────────────
export async function searchChunks(
  collection: typeof COLLECTIONS[keyof typeof COLLECTIONS],
  args: {
    vector:   number[]
    tenantId: string
    limit?:   number
    filter?:  Record<string, unknown>
  }
): Promise<Array<{ id: string | number; score: number; payload?: Record<string, unknown> | null }>> {
  const client = getQdrantClient()
  const tenantFilter = { key: 'tenant_id', match: { value: args.tenantId } }
  const must = args.filter ? [tenantFilter, args.filter] : [tenantFilter]
  const result = await client.search(collection, {
    vector: args.vector,
    filter: { must },
    limit:  args.limit ?? 10,
  })
  return result.map(r => ({ id: r.id, score: r.score, payload: r.payload }))
}

// ── Delete helper ───────────────────────────────────────────────────────────
export async function deleteChunks(
  collection: typeof COLLECTIONS[keyof typeof COLLECTIONS],
  pointIds: string[]
): Promise<void> {
  if (pointIds.length === 0) return
  const client = getQdrantClient()
  await client.delete(collection, { points: pointIds })
}

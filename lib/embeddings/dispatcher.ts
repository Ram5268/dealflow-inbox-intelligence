import { embedText, embedMultimodal, VOYAGE_MODELS } from './voyage'
import { COLLECTIONS } from '../vectorstore/qdrant'

// Routes a chunk to the right embedding model + Qdrant collection based on
// its chunk_type. Single entry point for all ingestion paths.

export type ChunkType =
  | 'email_body'
  | 'pdf_text'
  | 'pdf_table'
  | 'pdf_image'
  | 'linked_html'
  | 'image_attachment'
  | 'inline_image'

export const IMAGE_CHUNK_TYPES: ReadonlySet<ChunkType> = new Set([
  'pdf_image',
  'image_attachment',
  'inline_image',
])

export const EMBEDDING_VERSION = '1.0'

export interface EmbedChunkInput {
  chunkType:    ChunkType
  textContent?: string            // For text chunks; for image chunks this is the caption.
  imageBase64?: string            // For image chunks; base64 without data URI prefix.
  imageMimeType?: string
}

export interface EmbedChunkResult {
  vector:           number[]
  model:            string
  embeddingVersion: string
  collection:       typeof COLLECTIONS[keyof typeof COLLECTIONS]
}

export async function embedChunk(input: EmbedChunkInput): Promise<EmbedChunkResult> {
  if (IMAGE_CHUNK_TYPES.has(input.chunkType)) {
    if (!input.imageBase64) {
      throw new Error(`Image chunk type ${input.chunkType} requires imageBase64`)
    }
    const [vector] = await embedMultimodal([{
      content: [
        ...(input.textContent ? [{ type: 'text' as const, text: input.textContent }] : []),
        {
          type:          'image_base64' as const,
          imageBase64:   input.imageBase64,
          imageMimeType: input.imageMimeType ?? 'image/png',
        },
      ],
    }])
    return {
      vector,
      model:            VOYAGE_MODELS.multimodal,
      embeddingVersion: EMBEDDING_VERSION,
      collection:       COLLECTIONS.multimodal,
    }
  }

  if (!input.textContent) {
    throw new Error(`Text chunk type ${input.chunkType} requires textContent`)
  }
  const [vector] = await embedText([input.textContent], 'document')
  return {
    vector,
    model:            VOYAGE_MODELS.text,
    embeddingVersion: EMBEDDING_VERSION,
    collection:       COLLECTIONS.text,
  }
}

// Batched version for ingestion. Same model, mixed inputs allowed (but image
// and text chunks will hit different models — split them yourself first if
// you want a single API call). Returns results in input order.
export async function embedChunkBatch(inputs: EmbedChunkInput[]): Promise<EmbedChunkResult[]> {
  return Promise.all(inputs.map(embedChunk))
}

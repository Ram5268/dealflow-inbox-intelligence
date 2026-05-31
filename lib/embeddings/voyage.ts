import { VoyageAIClient } from 'voyageai'

// Voyage AI embedding wrapper. Text embeddings via voyage-3-large (1024 dim);
// multimodal embeddings via voyage-multimodal-3 (1024 dim). Both feed the
// same Qdrant infrastructure under different collections.
export const VOYAGE_MODELS = {
  text:       'voyage-3-large',
  multimodal: 'voyage-multimodal-3',
} as const

let cachedClient: VoyageAIClient | null = null

function getClient(): VoyageAIClient {
  if (cachedClient) return cachedClient
  const apiKey = process.env.VOYAGE_API_KEY
  if (!apiKey) throw new Error('VOYAGE_API_KEY must be set in env.')
  cachedClient = new VoyageAIClient({ apiKey })
  return cachedClient
}

// ── Text embedding ──────────────────────────────────────────────────────────
// inputType:
//   'document' — for chunks being indexed (default; what we use for ingestion)
//   'query'    — for search queries at retrieval time
//
// Returns 1024-dim embeddings, one per input. Voyage accepts up to 128 texts
// per call; callers should batch larger sets externally.
export async function embedText(
  texts: string[],
  inputType: 'document' | 'query' = 'document'
): Promise<number[][]> {
  if (texts.length === 0) return []
  const client = getClient()
  const response = await client.embed({
    input:     texts,
    model:     VOYAGE_MODELS.text,
    inputType,
  })
  return (response.data ?? []).map(d => d.embedding ?? [])
}

// ── Multimodal embedding ────────────────────────────────────────────────────
// Each input is an array of content parts; each part is either text or a
// base64-encoded image. The model places all parts into a shared 1024-dim
// space so text queries can retrieve image chunks and vice versa.
//
// imageBase64 should be a base64 string WITHOUT the data: URI prefix.
export interface MultimodalContent {
  type: 'text' | 'image_base64'
  text?: string
  imageBase64?: string
  imageMimeType?: string
}

export async function embedMultimodal(
  inputs: Array<{ content: MultimodalContent[] }>
): Promise<number[][]> {
  if (inputs.length === 0) return []
  const client = getClient()
  const response = await client.multimodalEmbed({
    inputs: inputs.map(i => ({
      content: i.content.map(p => {
        if (p.type === 'text') {
          return { type: 'text' as const, text: p.text ?? '' }
        }
        return {
          type: 'image_base64' as const,
          imageBase64: `data:${p.imageMimeType ?? 'image/png'};base64,${p.imageBase64 ?? ''}`,
        }
      }),
    })),
    model: VOYAGE_MODELS.multimodal,
  })
  return (response.data ?? []).map(d => d.embedding ?? [])
}

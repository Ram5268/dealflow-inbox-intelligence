// Voyage AI embedding wrapper. Uses Voyage's REST API directly instead of
// the official SDK, which had packaging issues in 0.2.1 (broken ESM bundle
// referencing non-existent local files). REST is two stable endpoints —
// /v1/embeddings for text and /v1/multimodalembeddings for text + image.
//
// Text embeddings via voyage-3-large (1024 dim); multimodal embeddings via
// voyage-multimodal-3 (1024 dim). Both feed Qdrant under different collections.

const VOYAGE_API_BASE = 'https://api.voyageai.com/v1'

export const VOYAGE_MODELS = {
  text:       'voyage-3-large',
  multimodal: 'voyage-multimodal-3',
} as const

function getApiKey(): string {
  const key = process.env.VOYAGE_API_KEY
  if (!key) throw new Error('VOYAGE_API_KEY must be set in env.')
  return key
}

interface TextEmbedResponse {
  data:  Array<{ embedding: number[]; index: number }>
  model: string
  usage: { total_tokens: number }
}

// ── Text embedding ──────────────────────────────────────────────────────────
// inputType: 'document' for indexed chunks, 'query' for search queries at
// retrieval time. Voyage accepts up to 128 inputs per call.
export async function embedText(
  texts: string[],
  inputType: 'document' | 'query' = 'document'
): Promise<number[][]> {
  if (texts.length === 0) return []

  const res = await fetch(`${VOYAGE_API_BASE}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input:      texts,
      model:      VOYAGE_MODELS.text,
      input_type: inputType,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Voyage embed failed (${res.status}): ${body.slice(0, 300)}`)
  }
  const json = (await res.json()) as TextEmbedResponse
  return (json.data ?? []).map(d => d.embedding ?? [])
}

// ── Multimodal embedding ────────────────────────────────────────────────────
export interface MultimodalContent {
  type: 'text' | 'image_base64'
  text?: string
  imageBase64?: string
  imageMimeType?: string
}

interface MultimodalEmbedResponse {
  data:  Array<{ embedding: number[]; index: number }>
  model: string
  usage: { text_tokens?: number; image_pixels?: number; total_tokens?: number }
}

export async function embedMultimodal(
  inputs: Array<{ content: MultimodalContent[] }>
): Promise<number[][]> {
  if (inputs.length === 0) return []

  const transformedInputs = inputs.map(i => ({
    content: i.content.map(p => {
      if (p.type === 'text') {
        return { type: 'text' as const, text: p.text ?? '' }
      }
      return {
        type:         'image_base64' as const,
        image_base64: `data:${p.imageMimeType ?? 'image/png'};base64,${p.imageBase64 ?? ''}`,
      }
    }),
  }))

  const res = await fetch(`${VOYAGE_API_BASE}/multimodalembeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: transformedInputs,
      model:  VOYAGE_MODELS.multimodal,
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Voyage multimodal embed failed (${res.status}): ${body.slice(0, 300)}`)
  }
  const json = (await res.json()) as MultimodalEmbedResponse
  return (json.data ?? []).map(d => d.embedding ?? [])
}

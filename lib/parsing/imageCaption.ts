import Anthropic from '@anthropic-ai/sdk'

// Claude Sonnet 4.6 vision captioner. Used for inline email images, PDF page
// images, and image attachments. Returns a factual description — NOT marketing
// language — suitable for embedding as text alongside the multimodal embedding.
let cachedClient: Anthropic | null = null

function getClient(): Anthropic {
  if (cachedClient) return cachedClient
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY must be set in env.')
  cachedClient = new Anthropic({ apiKey })
  return cachedClient
}

const CAPTION_PROMPT = `Describe this image as it relates to real estate. Be specific and factual; no marketing language.

If it's a floor plan: describe layout (bedroom/bathroom count if visible, key rooms, square footage if shown, orientation/aspects).
If it's an interior or exterior photo: describe condition, notable features, style (modern, prewar, etc), light/views.
If it's a chart or graph: summarize the data and what it shows.
If it's signage, a flyer, or marketing image: transcribe any text verbatim, then describe layout.
If it's a map: describe what's shown and the area.
If it shows no real estate content: respond with exactly "NONE — not real estate".

Under 250 words.`

export async function captionImage(
  imageBase64: string,
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' = 'image/png'
): Promise<string> {
  const client = getClient()
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
        { type: 'text',  text: CAPTION_PROMPT },
      ],
    }],
  })
  const block = response.content[0]
  if (block.type !== 'text') return ''
  return block.text.trim()
}

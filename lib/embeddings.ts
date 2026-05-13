import OpenAI from 'openai'
import { prisma } from './prisma'

const MODEL = 'text-embedding-3-small' // 1536 dims, cheap, fast

export function buildOpportunityText(o: {
  extractedTitle: string
  extractedSummary: string
  category: string
  neighborhood?: string | null
  borough?: string | null
  address?: string | null
  propertyType?: string | null
  beds?: number | null
  baths?: number | null
  units?: number | null
  price?: number | null
  minPrice?: number | null
  maxPrice?: number | null
  sourceBrokerage?: string | null
  sourceAgentName?: string | null
  availabilityDate?: string | null
}): string {
  const parts = [
    o.extractedTitle,
    o.extractedSummary,
    o.category.replace(/_/g, ' ').toLowerCase(),
    o.neighborhood ?? '',
    o.borough ?? '',
    o.address ?? '',
    o.propertyType ?? '',
    o.beds ? `${o.beds} bedrooms` : '',
    o.baths ? `${o.baths} bathrooms` : '',
    o.units ? `${o.units} units` : '',
    o.price ? `$${o.price.toLocaleString()}` : '',
    o.minPrice ? `from $${o.minPrice.toLocaleString()}` : '',
    o.maxPrice ? `up to $${o.maxPrice.toLocaleString()}` : '',
    o.sourceBrokerage ?? '',
    o.sourceAgentName ?? '',
    o.availabilityDate ?? '',
  ]
  return parts.filter(Boolean).join(' | ')
}

export async function embedText(text: string): Promise<number[]> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const response = await client.embeddings.create({ model: MODEL, input: text })
  return response.data[0].embedding
}

export async function upsertOpportunityEmbedding(opportunityId: string, text: string): Promise<void> {
  const vector = await embedText(text)
  const pgVector = `[${vector.join(',')}]`
  await prisma.$executeRaw`
    UPDATE "ExtractedOpportunity"
    SET embedding = ${pgVector}::vector
    WHERE id = ${opportunityId}
  `
}

export async function semanticSearch(queryText: string, limit = 15): Promise<string[]> {
  const vector = await embedText(queryText)
  const pgVector = `[${vector.join(',')}]`

  const rows = await prisma.$queryRaw<{ id: string; similarity: number }[]>`
    SELECT id, 1 - (embedding <=> ${pgVector}::vector) AS similarity
    FROM "ExtractedOpportunity"
    WHERE embedding IS NOT NULL
      AND "isDuplicate" = false
    ORDER BY embedding <=> ${pgVector}::vector
    LIMIT ${limit}
  `
  return rows.map(r => r.id)
}

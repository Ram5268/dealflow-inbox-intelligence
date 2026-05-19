import OpenAI from 'openai'
import type { ParsedQuery } from './types'

// ── Detect if a query needs decomposition ────────────────────────────────────
// Pure logic — no LLM. Returns true when multiple distinct intents are detected.
export function needsDecomposition(query: string, parsed: ParsedQuery): boolean {
  const lower = query.toLowerCase()

  // Already simple and confident — skip decomposition
  if (parsed.confidence >= 0.8 && parsed.neighborhoods.length <= 2 && !hasMultipleIntents(lower)) {
    return false
  }

  return hasMultipleIntents(lower)
}

function hasMultipleIntents(lower: string): boolean {
  // Explicit OR between different criteria
  if (/\bor\b/.test(lower) && (
    /\bor\s+(a\s+)?(condo|co-op|townhouse|loft|multi.?family|development|rental|sale)/i.test(lower) ||
    /\bor\s+(anything|something)\s+(in|similar|else)/i.test(lower) ||
    /(sale|rental|buy|rent).{0,30}\bor\b.{0,30}(sale|rental|buy|rent)/i.test(lower)
  )) return true

  // "either...or" pattern
  if (/either.{0,60}or\b/i.test(lower)) return true

  // Multiple property types mentioned with different contexts
  if (/\b(multi.?family|2-family|4-family)\b/.test(lower) && /\b(condo|co-op|development|site)\b/.test(lower)) return true

  // "and also" / "as well as" with real estate context
  if (/\b(and also|as well as|in addition)\b/.test(lower) && /\b(listing|rental|buyer|seller|development|off.?market)\b/.test(lower)) return true

  // Investor/developer queries that span categories
  if (/\b(investor|developer)\b/.test(lower) && /\b(or|and)\b/.test(lower)) return true

  // Explicit multi-category: "buyer ISOs AND listings"
  if (/\b(buyer iso|renter inquiry|iso)\b/.test(lower) && /\b(listing|rental|for sale|for rent)\b/.test(lower)) return true

  return false
}

// ── LLM decomposition ─────────────────────────────────────────────────────────
const DECOMPOSE_SYSTEM = `You are breaking a complex real estate search query into 2-3 focused sub-queries.
Each sub-query should capture ONE specific intent from the original.
Keep each sub-query short and concrete — as if a user typed it directly.

Rules:
- Maximum 3 sub-queries
- Each sub-query must be meaningfully different (different category, neighborhood, or criteria)
- Preserve neighborhood and budget context in each sub-query
- Never repeat the same sub-query twice

Return ONLY valid JSON: { "subQueries": ["query1", "query2"] }`

export async function decomposeQuery(query: string): Promise<string[]> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  try {
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: DECOMPOSE_SYSTEM },
        { role: 'user',   content: `Decompose this query: "${query}"` },
      ],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    })

    const raw  = res.choices[0].message.content ?? '{}'
    const data = JSON.parse(raw) as { subQueries?: string[] }
    const subs = data.subQueries ?? []

    // Validate: must be 2-3 non-empty strings
    const valid = subs.filter(s => typeof s === 'string' && s.trim().length > 3)
    if (valid.length < 2) return [query]  // fallback to original if decomposition fails

    return valid.slice(0, 3)
  } catch {
    return [query]  // fallback to original on any error
  }
}

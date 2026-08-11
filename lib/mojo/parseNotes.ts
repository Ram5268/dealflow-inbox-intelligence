// Brief 7.2 (Fix #7) — extract buyer/renter criteria from free-text call notes.
//
// Claude Sonnet 4.6 (product-surface per CLAUDE.md), hallucination-safe: every
// field defaults to null unless the notes state it explicitly. "Chelsea deal"
// does NOT set initialNeighborhood='Chelsea'; only "wants Chelsea" does. Vague
// words ("affordable") stay null. This mirrors the extraction rules in CLAUDE.md
// — prefer null over inference.
import Anthropic from '@anthropic-ai/sdk'

export interface ParsedNotes {
  bedsMin: number | null
  bedsMax: number | null
  budgetMin: number | null
  budgetMax: number | null
  cashOnly: boolean | null
  timing: string | null
  initialNeighborhood: string | null
}

const SONNET_MODEL = 'claude-sonnet-4-6'
const MIN_NOTES_LENGTH = 20

// Minimal Anthropic surface, so tests can inject a fake without a real key.
export interface NotesClient {
  messages: { create: (args: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> }
}

const EMPTY: ParsedNotes = {
  bedsMin: null,
  bedsMax: null,
  budgetMin: null,
  budgetMax: null,
  cashOnly: null,
  timing: null,
  initialNeighborhood: null,
}

let cachedClient: Anthropic | null = null
function getClient(): Anthropic {
  if (cachedClient) return cachedClient
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY must be set in env.')
  cachedClient = new Anthropic({ apiKey })
  return cachedClient
}

const PROMPT = `You extract real-estate buyer/renter criteria from a call note. Return ONLY a JSON object with these exact keys, using null for anything not explicitly stated:

{
  "bedsMin": number | null,
  "bedsMax": number | null,
  "budgetMin": number | null,
  "budgetMax": number | null,
  "cashOnly": boolean | null,
  "timing": string | null,
  "initialNeighborhood": string | null
}

Strict rules — never guess:
- Return null for any field not explicitly stated in the notes.
- Do NOT infer from context. "Chelsea deal" is NOT initialNeighborhood='Chelsea'; only phrasing like "wants Chelsea" / "looking in Chelsea" counts.
- cashOnly=true ONLY if the notes explicitly say cash / no financing. Otherwise null.
- budgetMin/budgetMax only from specific numbers ("up to 2M" -> budgetMax 2000000; "2-3M" -> min 2000000, max 3000000). "affordable"/"cheap" = null. Express dollars as plain numbers.
- timing is a short verbatim-ish phrase only if stated ("ASAP", "spring 2026", "in 3 months").
- Output the JSON object and nothing else.

Notes:
`

function num(v: unknown): number | null {
  if (typeof v === 'number' && !isNaN(v)) return v
  return null
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}
function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim()
  return null
}

export async function parseNotes(notes: string, opts?: { client?: NotesClient }): Promise<ParsedNotes> {
  const text = (notes ?? '').trim()
  // Skip the LLM call entirely for trivially short notes — nothing to extract.
  if (text.length < MIN_NOTES_LENGTH) return { ...EMPTY }

  let client: NotesClient
  try {
    client = opts?.client ?? (getClient() as unknown as NotesClient)
  } catch {
    return { ...EMPTY }
  }

  try {
    const response = await client.messages.create({
      model: SONNET_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: PROMPT + text }],
    })
    const block = response.content[0]
    if (!block || block.type !== 'text' || !block.text) return { ...EMPTY }

    // Be defensive: the model may wrap JSON in prose or a code fence.
    const match = block.text.match(/\{[\s\S]*\}/)
    if (!match) return { ...EMPTY }
    const parsed = JSON.parse(match[0]) as Record<string, unknown>

    return {
      bedsMin: num(parsed.bedsMin),
      bedsMax: num(parsed.bedsMax),
      budgetMin: num(parsed.budgetMin),
      budgetMax: num(parsed.budgetMax),
      cashOnly: bool(parsed.cashOnly),
      timing: str(parsed.timing),
      initialNeighborhood: str(parsed.initialNeighborhood),
    }
  } catch {
    // Network / parse failure → hallucination-safe all-null, never crash ingest.
    return { ...EMPTY }
  }
}

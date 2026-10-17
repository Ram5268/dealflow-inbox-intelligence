// Phase 4.0 — Sonnet tool_use adapter for V2 extraction.
//
// Wraps @anthropic-ai/sdk messages.create in forced tool_use mode. The model
// is required to call a single named tool whose input_schema is the JSON Schema
// for the target category. We return the tool_use.input, re-validated against
// the original Zod schema for safety (Claude is not as strict about JSON Schema
// as OpenAI's structured-output mode, so the Zod pass is the real guarantee).
//
// Per the Phase 4 decision tree: a 5xx or rate-limit gets ONE retry after 30s;
// if it still fails we surface the error to the caller (which logs + skips —
// V2 never writes a stub row). A valid tool_use input that fails Zod is logged
// with the full issue path and also skipped.
import Anthropic from '@anthropic-ai/sdk'
import type { ZodType } from 'zod'
import { toolInputShape } from './toolInputShape'

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const RETRY_DELAY_MS = 30_000

let client: Anthropic | null = null
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
    client = new Anthropic({ apiKey })
  }
  return client
}

export interface SonnetUsage {
  inputTokens:        number
  outputTokens:       number
  cacheReadTokens:    number
  cacheCreationTokens: number
}

export interface SonnetExtractResult<T> {
  /** Validated tool input, or null if the call failed or Zod rejected it. */
  data:      T | null
  /** Raw tool_use.input as returned by Claude (for diagnostics on Zod failure). */
  toolInput: unknown
  usage:     SonnetUsage | null
  /** Non-null when the extraction should be treated as a skip (caller logs). */
  error:     string | null
}

export interface ExtractWithSonnetOptions<T> {
  systemPrompt:    string
  userMessage:     string
  /** Tool name Claude is forced to call (also the schema namespace). */
  toolName:        string
  toolDescription: string
  /** JSON Schema (draft 2020-12) describing the tool input. */
  inputSchema:     Anthropic.Messages.Tool.InputSchema
  /** Zod schema for post-call validation of tool_use.input. */
  zodSchema:       ZodType<T>
  /** Optional PDF bytes — adds a document content block (wired for Phase 4.2). */
  pdfBytes?:       Uint8Array
  modelId?:        string
  maxTokens?:      number
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    const status = err.status
    return status === 429 || (typeof status === 'number' && status >= 500)
  }
  // Network/connection errors are also worth one retry.
  return err instanceof Anthropic.APIConnectionError
}

function readUsage(usage: Anthropic.Messages.Usage | undefined | null): SonnetUsage | null {
  if (!usage) return null
  return {
    inputTokens:         usage.input_tokens ?? 0,
    outputTokens:        usage.output_tokens ?? 0,
    cacheReadTokens:     usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  }
}

export async function extractWithSonnet<T>(
  opts: ExtractWithSonnetOptions<T>,
): Promise<SonnetExtractResult<T>> {
  const anthropic = getClient()
  const model = opts.modelId ?? DEFAULT_MODEL

  // The user content: optional PDF document block first, then the text prompt.
  // cache_control on the text block lets the (large, per-category-identical)
  // prompt body be reused across a batch of same-category emails.
  const content: Anthropic.Messages.ContentBlockParam[] = []
  if (opts.pdfBytes) {
    content.push({
      type:   'document',
      source: {
        type:       'base64',
        media_type: 'application/pdf',
        data:       Buffer.from(opts.pdfBytes).toString('base64'),
      },
    })
  }
  content.push({ type: 'text', text: opts.userMessage })

  // System prompt as a cacheable block — identical across all emails of a
  // category, so we mark it ephemeral to get prompt-cache hits during a batch.
  const system: Anthropic.Messages.TextBlockParam[] = [
    { type: 'text', text: opts.systemPrompt, cache_control: { type: 'ephemeral' } },
  ]

  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model,
    // 16384 so high-cardinality multi-listing broker blasts don't truncate the
    // tool_use JSON mid-array (the Phase 4.5 pilot saw 4096 cut off ~10-listing
    // outputs -> Zod "listings: expected array, received undefined"). Sonnet 4.6
    // allows 16384 natively (no extended-output beta header); >=32000 would trip
    // the SDK's non-streaming 10-min guard. Cost is unchanged for normal emails —
    // you only pay for tokens actually generated.
    max_tokens: opts.maxTokens ?? 16384,
    // temperature=0 for deterministic structured tool_use output (V1 used the
    // same for its extractors). Removes run-to-run nondeterminism and trims
    // noise from confidence scores.
    temperature: 0,
    system,
    messages: [{ role: 'user', content }],
    tools: [{
      name:         opts.toolName,
      description:  opts.toolDescription,
      input_schema: opts.inputSchema,
    }],
    tool_choice: { type: 'tool', name: opts.toolName },
  }

  let response: Anthropic.Messages.Message
  try {
    response = await anthropic.messages.create(params)
  } catch (err) {
    if (isRetryable(err)) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
      try {
        response = await anthropic.messages.create(params)
      } catch (err2) {
        return { data: null, toolInput: null, usage: null, error: `Sonnet API error (after retry): ${(err2 as Error).message}` }
      }
    } else {
      return { data: null, toolInput: null, usage: null, error: `Sonnet API error: ${(err as Error).message}` }
    }
  }

  const usage = readUsage(response.usage)

  const toolUse = response.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
  )
  if (!toolUse) {
    return { data: null, toolInput: null, usage, error: 'Sonnet returned no tool_use block' }
  }

  const parsed = opts.zodSchema.safeParse(toolUse.input)
  if (!parsed.success) {
    // Per decision tree: log full Zod path + the shape of the Sonnet output,
    // write nothing. Brief 41.1: never the output's text, which can carry a
    // seller's personal circumstances or a name.
    const issues = parsed.error.issues
      .slice(0, 5)
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    console.error(
      `[sonnetExtractor] Zod validation failed for tool ${opts.toolName}: ${issues}`,
      `\n  toolInput shape: ${toolInputShape(toolUse.input, opts.inputSchema).slice(0, 1500)}`,
    )
    return { data: null, toolInput: toolUse.input, usage, error: `Zod validation failed: ${issues}` }
  }

  return { data: parsed.data, toolInput: toolUse.input, usage, error: null }
}

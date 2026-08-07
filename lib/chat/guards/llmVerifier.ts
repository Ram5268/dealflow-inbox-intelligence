// Brief 5.1, Step 2 — Sonnet 4.6 semantic hallucination verifier.
//
// The regex guard (regexGuard.ts) catches the STRUCTURAL shape of a
// hallucination — a URL, a source name, an LLC. This catches the SEMANTIC
// residue it can't: an invented ownership name that looks like a person, a
// fabricated statistic phrased without the trigger words, a made-up follow-up
// detail. It asks a second Sonnet call to fact-check every specific claim in
// Drift's response against the exact tool results Drift was given.
//
// Product-surface rule (CLAUDE.md) + the "no shortcuts" directive => the
// verifier runs on claude-sonnet-4-6, same as the chat model itself.
//
// Testability: verifyResponse accepts an optional injected client so unit tests
// exercise the parse / fail-safe / cost logic without spending real API calls.
import Anthropic from '@anthropic-ai/sdk'

export interface VerifierFlag {
  claim: string // exact substring from response that isn't grounded
  reason: string // why it isn't supported by tool results
}

export interface VerifierResult {
  isGrounded: boolean
  flags: VerifierFlag[]
  costUsd: number
  latencyMs: number
}

export interface ToolResultForVerify {
  name: string
  input: unknown
  output: unknown
}

export const VERIFIER_MODEL = 'claude-sonnet-4-6'

// Sonnet 4.6 list pricing.
const VERIFIER_INPUT_PER_M = 3
const VERIFIER_OUTPUT_PER_M = 15

export function computeCostUsd(tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1_000_000) * VERIFIER_INPUT_PER_M + (tokensOut / 1_000_000) * VERIFIER_OUTPUT_PER_M
}

export const VERIFIER_SYSTEM_PROMPT = `You are a fact-checker for a real-estate broker's AI chat assistant. Given a user query, tool results the assistant received, and the assistant's response, identify any factual claims in the response that are NOT supported by the tool results.

Rules:
- Extract every specific factual claim (names, prices, dates, addresses, statistics, URLs, ownership, sale history, market data, external source citations).
- For each claim, check whether it appears in or can be directly derived from the tool results.
- Ignore subjective commentary ("great value", "priced to sell", "family-friendly neighborhood") — those are opinions, not fact-checkable.
- Ignore obvious NYC general knowledge ("Park Slope is in Brooklyn", "prewar buildings are older"). But FLAG specific numeric/named claims about NYC not in tool results.
- Do NOT hallucinate flags — if a claim IS in the tool results, do not flag it.

Return strict JSON: {"isGrounded": boolean, "flags": [{"claim": string, "reason": string}]}`

// Minimal shape of the Anthropic client method we depend on — lets tests inject
// a fake without pulling in the full SDK surface.
export interface VerifierClient {
  messages: {
    create: (args: Anthropic.Messages.MessageCreateParamsNonStreaming) => Promise<Anthropic.Messages.Message>
  }
}

function buildUserMessage(
  userQuery: string,
  toolResults: ToolResultForVerify[],
  candidateResponse: string,
): string {
  return [
    '<user_query>',
    userQuery,
    '</user_query>',
    '',
    '<tool_results>',
    JSON.stringify(toolResults),
    '</tool_results>',
    '',
    '<assistant_response>',
    candidateResponse,
    '</assistant_response>',
  ].join('\n')
}

// Strict-ish JSON parse: try direct, then a fenced/embedded-object fallback,
// then fail safe. Fail-safe = treat as UNGROUNDED so a parser failure never
// lets an unverified response through.
function parseVerdict(text: string): { isGrounded: boolean; flags: VerifierFlag[] } | null {
  const attempts: string[] = []
  const trimmed = text.trim()
  attempts.push(trimmed)
  // Strip ```json ... ``` fences if present.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) attempts.push(fence[1].trim())
  // First { … last } fallback.
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last > first) attempts.push(trimmed.slice(first, last + 1))

  for (const a of attempts) {
    try {
      const parsed = JSON.parse(a)
      if (typeof parsed?.isGrounded === 'boolean') {
        const flags: VerifierFlag[] = Array.isArray(parsed.flags)
          ? parsed.flags
              .filter((f: unknown): f is Record<string, unknown> => !!f && typeof f === 'object')
              .map((f: Record<string, unknown>) => ({
                claim: String(f.claim ?? ''),
                reason: String(f.reason ?? ''),
              }))
          : []
        return { isGrounded: parsed.isGrounded, flags }
      }
    } catch {
      /* try next */
    }
  }
  return null
}

/**
 * Fact-check a candidate Drift response against the tool results it was built
 * from. Returns isGrounded + any unsupported claims, plus cost/latency for
 * telemetry. Never throws — API/parse failures fail SAFE (ungrounded).
 */
export async function verifyResponse(
  userQuery: string,
  toolResults: ToolResultForVerify[],
  candidateResponse: string,
  opts?: { client?: VerifierClient },
): Promise<VerifierResult> {
  const t0 = Date.now()
  const client: VerifierClient =
    opts?.client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // Empty response with nothing to check is trivially grounded — skip the call.
  if (!candidateResponse.trim()) {
    return { isGrounded: true, flags: [], costUsd: 0, latencyMs: Date.now() - t0 }
  }

  try {
    const completion = await client.messages.create({
      model: VERIFIER_MODEL,
      max_tokens: 800,
      temperature: 0,
      system: VERIFIER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(userQuery, toolResults, candidateResponse) }],
    })

    const tokensIn = completion.usage?.input_tokens ?? 0
    const tokensOut = completion.usage?.output_tokens ?? 0
    const costUsd = computeCostUsd(tokensIn, tokensOut)

    const textBlock = completion.content.find(
      (b): b is Anthropic.Messages.TextBlock => b.type === 'text',
    )
    const verdict = textBlock ? parseVerdict(textBlock.text) : null

    if (!verdict) {
      // Fail safe: unparseable verifier output => treat response as ungrounded.
      return {
        isGrounded: false,
        flags: [{ claim: 'verifier_parse_error', reason: 'Verifier returned unparseable output; failing safe to ungrounded.' }],
        costUsd,
        latencyMs: Date.now() - t0,
      }
    }

    return {
      isGrounded: verdict.isGrounded && verdict.flags.length === 0,
      flags: verdict.flags,
      costUsd,
      latencyMs: Date.now() - t0,
    }
  } catch (err) {
    // API error => fail safe (ungrounded), but don't crash the chat route.
    return {
      isGrounded: false,
      flags: [{ claim: 'verifier_api_error', reason: `Verifier call failed: ${String(err)}` }],
      costUsd: 0,
      latencyMs: Date.now() - t0,
    }
  }
}

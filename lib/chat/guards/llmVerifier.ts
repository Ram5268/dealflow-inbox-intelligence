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

export const VERIFIER_SYSTEM_PROMPT = `You are a fact-checker for a real-estate broker's AI chat assistant ("Drift"). Given a user query, tool results the assistant received, SIDE-CHANNEL CONTEXT the assistant was also given, and the assistant's response, identify factual claims in the response that are NOT supported by that evidence AND are not allowed general/self-knowledge.

GROUNDED EVIDENCE = tool results OR side-channel context. Both are real, retrieved data. The side-channel context block carries live public-records and market data the system fetched for this turn (e.g. ACRIS ownership + sale history, DOB permits + violations, FRED mortgage rates, Mojo CRM leads, calendar). A fact that appears in the tool results OR in the side-channel context is grounded — do NOT flag it. Only flag a specific claim that appears in NEITHER. In particular, an owner name / LLC entity / sale price / permit / mortgage rate that is present in the side-channel context is grounded evidence, NOT a hallucination, even though it did not come from a tool call.

The assistant is an experienced NYC broker. It is EXPECTED to layer its own NYC geography and neighborhood knowledge on top of the tool results. That layering is legitimate and must NOT be flagged. Only fabricated PROPERTY-SPECIFIC facts (numbers, ownership, history, external data) are hallucinations.

ALLOWED — do NOT flag these:
- Neighborhood name inferred from an address that IS in the tool results (e.g., a card at "200 E 33rd St" → "Murray Hill / Midtown South"; "461 6th St" → "Park Slope"). Inferring the neighborhood/sub-neighborhood/borough of a known address is broker knowledge, not a fabricated fact.
- Transit adjacency for an address in the tool results (e.g., "175 Kent is near the Bedford Ave L", naming nearby subway lines/stops like "Lorimer" or "Graham").
- Building-era or block-character context tied to an address in the tool results ("W 19th and W 20th are prewar Chelsea", "Willow St is a brownstone row", "Astoria Blvd is near the Hell Gate waterfront strip").
- Descriptions of the assistant's OWN capabilities and architecture — its tools (search_listings, search_parties), that it reads the broker's inbox/extracted listings, Mojo CRM leads, calendar, that it can draft outreach but cannot send email or read public records. These describe the system itself, not property facts. The assistant may freely explain what it can and cannot do.
- Subjective commentary ("great value", "priced to sell", "family-friendly").
- Obvious NYC general knowledge ("Park Slope is in Brooklyn", "the UWS is uptown", "prewar buildings are older").
- Simple arithmetic derived from numbers that ARE in the tool results or supplied by the user (e.g., computing a monthly payment or rent-multiple from a stated price).

STILL FLAG — these are hallucinations, do NOT let them pass:
- Property-specific numeric claims NOT in the tool results: square footage, maintenance/common charges, tax amounts, cap rate, NOI, closing costs, mansion tax figures, transfer-tax rates, title insurance, comps, or $/sqft figures for a specific property or neighborhood.
- Ownership claims (owner names, LLC/Corp entity names, purchase history, transfer dates).
- URLs of any kind — the assistant has no URL-returning tool, so ANY URL is fabricated.
- Sale-history claims ("last sold in 2019 for $X").
- Zoning designations, DOB violations, or tax-history claims for a property.
- Named external data sources cited as if read from them ("per ACRIS", "PropertyShark shows…", "on StreetEasy at $Y", "MLS/RLS records").
- Cross-party match claims that VIOLATE a party's stated constraints in the tool results (e.g., matching a buyer whose card says "Chelsea, budget $2M" to a Park Slope listing, or to a listing above their budget).

Method:
- Extract each specific factual claim in the response.
- If it appears in / is directly derivable from the tool results, or falls under an ALLOWED category above, do NOT flag it.
- Only flag claims that fall under STILL FLAG and are absent from the tool results.
- Do NOT invent flags — when in doubt about allowed broker/self knowledge, do not flag; reserve flags for genuinely fabricated property-specific facts.

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
  sideChannelText: string | null,
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
    // Brief 26.0 — the side-channel context block Sonnet was given (ACRIS/DOB/
    // FRED/Mojo/calendar). This is grounded evidence too: facts here must NOT be
    // flagged as hallucinations just because they didn't arrive via a tool call.
    '<side_channel_context grounded="true">',
    sideChannelText ?? '(none)',
    '</side_channel_context>',
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
  sideChannelText: string | null,
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
      messages: [{ role: 'user', content: buildUserMessage(userQuery, toolResults, sideChannelText, candidateResponse) }],
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

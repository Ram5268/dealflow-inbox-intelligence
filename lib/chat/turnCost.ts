// Brief 43 PR 15 (Q37; Brief 46 drift-2 "Does the app record usage?"): what a
// chat turn's Claude calls cost. DriftInteraction.costUsd used to count only the
// uncached input and the output of Drift's own calls, so it missed cache writes
// and reads (20–75% of those calls), the fact-check and the report section's
// Sonnet call. PR 17's daily cap (lib/spendGuard.ts) sums that column, so it now
// counts the real spend [engineering precaution]. The gpt-4o-mini parser and
// chat-title calls (about 0.01¢ each) are still not counted.
//
// Prices: Sonnet 4.6 list prices, the constants the extractor and the matcher
// already use (lib/matching/cost.ts): $3 per million input tokens, $15 output,
// $3.75 cache write (1.25× input, 5-minute cache) and $0.30 cache read (0.1×).
//
// Relative imports, so the unit tests' runner resolves them (as systemBlocks.ts).
import type Anthropic from '@anthropic-ai/sdk'
import { sonnetCostUsd } from '../matching/cost'
import type { SonnetUsage } from '../extraction/sonnetExtractor'

export interface UsageTally extends SonnetUsage {
  calls: number
}

type UsageLike = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

export function newUsageTally(): UsageTally {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
}

/** Add one call's usage to the tally (a missing field counts as 0). */
export function addUsage(t: UsageTally, usage: UsageLike | null | undefined): void {
  t.calls++
  if (!usage) return
  t.inputTokens         += usage.input_tokens ?? 0
  t.outputTokens        += usage.output_tokens ?? 0
  t.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0
  t.cacheReadTokens     += usage.cache_read_input_tokens ?? 0
}

export function tallyCostUsd(t: UsageTally): number {
  return sonnetCostUsd(t)
}

export interface TurnUsage {
  main: UsageTally        // Drift's own calls: tool rounds, forced reply, guard retries, draft rewrite
  reports: UsageTally     // the report generators' Sonnet calls (recommended-adjustment)
  verifierCostUsd: number // the fact-checks (guard telemetry; llmVerifier.ts prices them)
}

/** DriftInteraction.costUsd for the turn. */
export function turnCostUsd(u: TurnUsage): number {
  return tallyCostUsd(u.main) + tallyCostUsd(u.reports) + u.verifierCostUsd
}

/** parsedFilters.usage: the tallies behind costUsd. Counts and dollars, no text. */
export function usageRecord(u: TurnUsage) {
  return {
    main:            { ...u.main, costUsd: tallyCostUsd(u.main) },
    reports:         { ...u.reports, costUsd: tallyCostUsd(u.reports) },
    verifierCostUsd: u.verifierCostUsd,
    totalUsd:        turnCostUsd(u),
  }
}

/**
 * The client handed to the report generators: every messages.create call's
 * usage is added to `tally`; everything else is the client itself.
 */
export function countingClient(client: Anthropic, tally: UsageTally): Anthropic {
  const create = async (...args: Parameters<Anthropic['messages']['create']>) => {
    const message = await client.messages.create(...args)
    addUsage(tally, (message as { usage?: UsageLike }).usage)
    return message
  }
  const messages = new Proxy(client.messages, {
    get: (target, key) => (key === 'create' ? create : Reflect.get(target, key)),
  })
  return new Proxy(client, {
    get: (target, key) => (key === 'messages' ? messages : Reflect.get(target, key)),
  })
}

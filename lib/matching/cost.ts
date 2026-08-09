// Brief 7.0 — Sonnet 4.6 cost accounting for the matching engine. Same per-token
// rates the extractor uses (lib/extraction/extractEmailV2.ts PRICE). Kept local
// so the matching engine has no dependency on the extraction module.
import type { SonnetUsage } from '../extraction/sonnetExtractor'

// USD per token.
export const SONNET_PRICE = {
  input:         3.0 / 1_000_000,
  output:        15.0 / 1_000_000,
  cacheRead:     0.30 / 1_000_000,
  cacheCreation: 3.75 / 1_000_000,
}

export function sonnetCostUsd(usage: SonnetUsage | null): number {
  if (!usage) return 0
  return (
    usage.inputTokens * SONNET_PRICE.input +
    usage.outputTokens * SONNET_PRICE.output +
    usage.cacheReadTokens * SONNET_PRICE.cacheRead +
    usage.cacheCreationTokens * SONNET_PRICE.cacheCreation
  )
}

// Thrown when a query's running Sonnet spend crosses the per-query kill-switch
// (MATCHING_SPEND_KILL_SWITCH_USD, default $0.50). Carries the running count so
// the caller can report how far the fan-out got before aborting — a silent
// geo-filter break shows up here as a runaway pair count, not a surprise bill.
export class MatchingCostAbort extends Error {
  constructor(
    public readonly runningCostUsd: number,
    public readonly pairsEvaluated: number,
    public readonly thresholdUsd: number,
  ) {
    super(
      `Matching cost kill-switch tripped: $${runningCostUsd.toFixed(4)} spent over ` +
      `${pairsEvaluated} pair(s), exceeds $${thresholdUsd.toFixed(2)} threshold. Aborting query.`,
    )
    this.name = 'MatchingCostAbort'
  }
}

export function killSwitchUsd(): number {
  const raw = process.env.MATCHING_SPEND_KILL_SWITCH_USD
  const parsed = raw ? parseFloat(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.50
}

// Brief 7.0 — LLM-scored tiering of a single party↔listing pair.
//
// Uses Sonnet 4.6 (a product-surface call per CLAUDE.md — matching quality is a
// product surface, NOT a utility call, so no gpt-4o-mini here). Forced tool_use
// gives structured {tier, reason} output, re-validated with Zod. Cost per pair
// is instrumented and returned so the engine can enforce its kill-switch.
//
// The tier is judged ONLY on fit; the StreetEasy-Expert source preference is
// applied deterministically downstream in ranking.ts, never by this rubric.
import { z } from 'zod'
import type Anthropic from '@anthropic-ai/sdk'
import { extractWithSonnet } from '../extraction/sonnetExtractor'
import { sonnetCostUsd } from './cost'
import { describeParty, describeListing } from './format'
import type { PartyContext, ListingContext, Tier } from './types'

const TIERING_SYSTEM = `You score how well ONE listing (supply) matches ONE party (a buyer or renter's demand) for a NYC real estate agent. Output a single tier and a one-sentence reason.

Judge ONLY fit between the two records. Do NOT consider where the party came from (source) — that is handled separately. Be decisive; when a pair is a hard mismatch, say None.

TIERS:
- "Hot": strong fit on the things that matter. Price fits (listing within ~15% of the party's budget/range), neighborhood is an exact or immediately-adjacent/alias match, the record is fresh (the newer side <7 days old), and there is NO disqualifying conflict (right transaction side, beds within ~1 of what's asked, no cash-only-vs-financed clash).
- "Warm": a solid partial fit. EITHER price fits OR neighborhood matches (not clearly both), OR a Hot-shaped fit that's slightly stale (newer side <30 days) or has a minor criteria gap (beds off by ~1, budget edge).
- "Possible": a broad, long-tail fit worth surfacing. Same borough, price within ~30% of range, some overlap in criteria, but not a clean fit on either price or neighborhood.
- "None": a hard mismatch that should NOT be shown. Wrong transaction side (a sale listing for a renter, or vice-versa), price gap >50% from the party's range, or a disqualifying criteria conflict. Missing data is NOT itself a mismatch — do not return None just because a field is null; judge on what IS known and lean Possible when thin.

RULES:
- The reason must be ONE sentence, concrete, and cite the actual drivers (e.g. "$2.1M list sits inside the $1.9–2.2M budget and Chelsea is an exact hood match"). No hedging boilerplate.
- Never invent facts not in the two records. If price or beds is missing on a side, weigh what remains; don't assume.
- Prefer None over a weak "Possible" only when there is a genuine disqualifier (wrong side, >50% price gap). Otherwise thin overlap is "Possible".`

const tierInputSchema = {
  type: 'object',
  properties: {
    tier:   { type: 'string', enum: ['Hot', 'Warm', 'Possible', 'None'] },
    reason: { type: 'string' },
  },
  required: ['tier', 'reason'],
} as Anthropic.Messages.Tool.InputSchema

const TierSchema = z.object({
  tier:   z.enum(['Hot', 'Warm', 'Possible', 'None']),
  reason: z.string().nullish().transform(v => v ?? ''),
})

export interface TierOutcome {
  tier:    Tier
  reason:  string
  costUsd: number
  /** Non-null when the tiering call itself failed — the engine logs it as a
   *  warning (never silent) and treats the pair as unscored/None. */
  error:   string | null
}

function daysAgo(d: Date, now: number): number {
  return Math.max(0, (now - d.getTime()) / 86_400_000)
}

/**
 * Score a single pair. `now` is passed in so a whole query dates every pair off
 * one clock (and so tests are deterministic).
 */
export async function tierMatch(
  party: PartyContext,
  listing: ListingContext,
  now: number = Date.now(),
): Promise<TierOutcome> {
  const partyAge = daysAgo(party.createdAt, now)
  const listingAge = daysAgo(listing.createdAt, now)
  const newerAge = Math.min(partyAge, listingAge)

  const userMessage =
    `PARTY (demand):\n` +
    `  ${describeParty(party)}\n` +
    `  transaction side: ${party.role}\n` +
    `  neighborhoods: ${party.neighborhoods.length ? party.neighborhoods.join(', ') : '(broad / unspecified)'}\n` +
    `  borough: ${party.borough ?? '(unspecified)'}\n` +
    `  budget: ${party.budgetMin ?? '?'}–${party.budgetMax ?? '?'}\n` +
    `  beds: ${party.bedsMin ?? '?'}–${party.bedsMax ?? '?'}\n` +
    `  cash only: ${party.cashOnly ? 'yes' : 'no'}\n` +
    `  timing: ${party.timing ?? '(unspecified)'}\n` +
    `  age: ${partyAge.toFixed(1)} days\n\n` +
    `LISTING (supply):\n` +
    `  ${describeListing(listing)}\n` +
    `  transaction side: ${listing.side}\n` +
    `  neighborhood: ${listing.neighborhood ?? '(unspecified)'}\n` +
    `  borough: ${listing.borough ?? '(unspecified)'}\n` +
    `  price: ${listing.price ?? '?'}\n` +
    `  beds: ${listing.beds ?? '?'}\n` +
    `  age: ${listingAge.toFixed(1)} days\n\n` +
    `Freshness note: the newer of the two records is ${newerAge.toFixed(1)} days old.\n` +
    `Return the tier and a one-sentence reason.`

  const result = await extractWithSonnet({
    systemPrompt:    TIERING_SYSTEM,
    userMessage,
    toolName:        'score_match',
    toolDescription: 'Return the match tier (Hot/Warm/Possible/None) and a one-sentence reason for this party↔listing pair.',
    inputSchema:     tierInputSchema,
    zodSchema:       TierSchema,
    maxTokens:       200,
  })

  const costUsd = sonnetCostUsd(result.usage)

  if (result.error || !result.data) {
    return { tier: 'None', reason: '', costUsd, error: result.error ?? 'no tiering data returned' }
  }
  return { tier: result.data.tier, reason: result.data.reason, costUsd, error: null }
}

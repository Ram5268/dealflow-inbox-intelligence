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

Judge ONLY fit between the two records. Do NOT consider where the party came from (source) — that is handled separately.

STEP 1 — classify the NEIGHBORHOOD relationship:
- EXACT/ALIAS: the listing's neighborhood equals one the party wants, or a well-known alias (FiDi = Financial District, LIC = Long Island City).
- ADJACENT: the listing is in a neighborhood that borders or is a sub-area of one the party wants (Greenpoint borders Williamsburg; West Chelsea is within Chelsea; Ridgewood borders Bushwick).
- SAME-BOROUGH-ONLY: same borough, but the specific neighborhoods differ and are NOT adjacent (Park Slope vs Bay Ridge; Chelsea vs Murray Hill) — OR the party gave no specific neighborhood at all (broad / borough-level demand).
- CROSS-BOROUGH: different boroughs (rare; it is pre-filtered).

STEP 2 — classify the PRICE relationship (listing price vs the party's budget/range):
- FITS: within ~15% of the range.  NEAR: ~15–30% off.  OFF: >30% off.  GAP: >50% off (a hard disqualifier).
- If price is missing on either side, price is UNKNOWN (not a mismatch).

STEP 3 — NONE override. Return "None" immediately (skip the rest) ONLY for a hard mismatch: wrong transaction side (sale vs rental), a price GAP (>50% off), or a genuine disqualifying conflict. Do NOT return None just because neighborhoods differ within the same borough, or because a field is null.

STEP 4 — compute a BASE tier from neighborhood + price (ignore freshness for now):
- BASE Hot   ← EXACT/ALIAS neighborhood AND price FITS on a KNOWN price. UNKNOWN (missing) price can NEVER be Hot — you cannot confirm the price fit — so exact hood + unknown price is BASE Warm, not Hot.
- BASE Warm  ← EXACT/ALIAS neighborhood with price NEAR / UNKNOWN / a minor bed gap (~1 off);  OR  ADJACENT neighborhood with price FITS or NEAR.
- BASE Possible ← SAME-BOROUGH-ONLY (different specific hoods, OR broad/no-hood demand) with price FITS or NEAR;  OR any real-but-thin fit.
  A broad party (no specific neighborhood) can never exceed BASE Possible on neighborhood grounds — you cannot confirm a sharp hood match. An EXACT/ALIAS neighborhood never falls below BASE Warm.

STEP 5 — apply the FRESHNESS CEILING using the newer of the two records' ages, then output the LOWER of the base tier and this ceiling:
- newer record <7 days  → ceiling Hot   (no demotion).
- newer record 7–60 days → ceiling Warm  (a base Hot becomes Warm).
- newer record >60 days → ceiling Possible (even a perfect exact-hood price-fit becomes Possible).
Final tier = min(BASE from step 4, freshness ceiling). ADJACENT is never Hot regardless of freshness (its base already caps at Warm).

RULES:
- The reason must be ONE sentence citing the actual drivers — name the neighborhood relationship (exact / adjacent / borough-only), the price relationship, and freshness when it changed the tier (e.g. "exact Chelsea match with $2.1M inside the $1.9–2.2M budget, both fresh" or "exact UES fit but 65-day-old records cap it at Possible"). No boilerplate.
- Never invent facts. If price or beds is missing, weigh what remains.`

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

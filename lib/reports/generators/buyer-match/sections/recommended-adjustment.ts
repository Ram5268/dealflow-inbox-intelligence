// Brief 27.0 — "Recommended adjustment" section. The one Sonnet-composed section:
// given the buyer's criteria and the inventory/near-miss picture, name the
// single tightest constraint to relax and what relaxing it would open up.
//
// Product-surface LLM call → Sonnet 4.6 (CLAUDE.md rule; never gpt-4o-mini).
// Anti-hallucination: Sonnet is given ONLY the criteria + match summary and told
// to reason from that alone. If no client is supplied (defensive), a deterministic
// fallback prose is returned instead.
import Anthropic from '@anthropic-ai/sdk'
import type { GenContext, SectionResult, SourceRef } from '../../types'
import { nowISO } from '../../types'
import { criteriaLine } from './_format'
import { fitLineOf } from './curated-matches'

const MODEL = 'claude-sonnet-4-6'

const SYSTEM = `You advise a NYC real estate broker. Given a buyer's search criteria and how the current inventory tiers against it, recommend the single tightest constraint to relax to unblock the buyer, and what relaxing it would likely open up. Rules: reason ONLY from the numbers and reasons provided; do not invent listings, prices, or neighborhoods; if the buyer already has strong fits, say the criteria are working and no change is needed. Answer in 2 to 4 sentences of plain prose. No markdown, no bullet points, no em-dashes.`

export async function recommendedAdjustmentSection(
  ctx: GenContext,
  anthropic?: Anthropic,
): Promise<SectionResult> {
  const b = ctx.buyer
  const matches = await ctx.matches()
  const hot = matches.filter(m => m.tier === 'HOT')
  const warm = matches.filter(m => m.tier === 'WARM')
  const possible = matches.filter(m => m.tier === 'POSSIBLE')
  // Brief 41 (H7): never a seller's circumstances or a homeowner's estimate.
  // Brief 48 PR 13 (Q34): the same lines the report shows (fitLineOf).
  const nearReasons = [...warm, ...possible].slice(0, 5).map(m => `- ${fitLineOf(m, b) ?? 'no reason recorded'}`).join('\n')

  const sources: SourceRef[] = [{ type: 'matcher', at: nowISO() }, { type: 'inbox', id: b.id, at: nowISO() }]

  const summary =
    `Buyer criteria: ${criteriaLine(b)}.\n` +
    `Inventory tiering: ${hot.length} clear fits, ${warm.length} warm, ${possible.length} possible.\n` +
    (nearReasons ? `Why the near-misses fell short:\n${nearReasons}` : `No near-misses recorded.`)

  const client = anthropic ?? (process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null)

  if (!client) {
    // Deterministic fallback — never blocks report generation on a missing key.
    // Brief 43 PR 14 (Q38): no em-dash in the prose (feel standard).
    const prose = hot.length > 0
      ? `The criteria are clearing inventory, with ${hot.length} clear fit${hot.length === 1 ? '' : 's'} on the board. No change needed this period; focus on getting showings booked.`
      : `Nothing tiers as a clear fit yet. The tightest constraint is usually price or neighborhood; widening one of them modestly is the fastest way to surface fits. (Narrative unavailable without the model.)`
    return { key: 'recommended-adjustment', title: 'Recommended adjustment', content: { prose }, sources }
  }

  try {
    const completion = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      temperature: 0.3,
      system: SYSTEM,
      messages: [{ role: 'user', content: summary }],
    })
    const text = completion.content.find((c): c is Anthropic.Messages.TextBlock => c.type === 'text')?.text?.trim()
    const prose = text && text.length > 0
      ? text
      : `Recommendation unavailable this period. ${hot.length} clear fits, ${warm.length} warm.`
    return { key: 'recommended-adjustment', title: 'Recommended adjustment', content: { prose }, sources }
  } catch (e) {
    const prose = `Recommendation could not be composed (${(e as Error).message}). ` +
      `Summary: ${hot.length} clear fits, ${warm.length} warm, ${possible.length} possible.`
    return { key: 'recommended-adjustment', title: 'Recommended adjustment', content: { prose }, sources }
  }
}

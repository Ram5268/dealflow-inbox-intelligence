// Brief 6.3 Fix #1B — lead-recovery second pass.
//
// A conservative safety net for when the primary classifier routes an email to an
// informational bucket (CLIENT_CONVERSATION / NOISE / MARKET_REPORT) but a real
// buyer/seller/landlord/renter intent is buried under the friendly/newsletter tone.
//
// It returns null unless there is EXPLICIT, concrete intent from a real person. A
// historical / sold comp or a past personal purchase is NOT a lead: it is returned
// with isHistoricalComp=true so the caller tags provenance='comp_reference' and keeps
// it out of match pools (see lib/matchmaking.ts, lib/chat/tools/searchParties.ts).
//
// NOTE: this is defense-in-depth. With the Brief 6.3 classifier tuning + widened
// body window, the classifier itself now routes the tested buried-lead cases
// correctly, so this pass is dormant for those. It exists for the long tail —
// signals buried below the classifier window in real inbox traffic. It runs from
// ingestEmailV2 (gated by INGESTION_TEST_MODE_ONLY until a real source is enabled).
import { z } from 'zod'
import type Anthropic from '@anthropic-ai/sdk'
import { extractWithSonnet } from './sonnetExtractor'
import type { MapCtx } from './schemas'

export interface RecoveredLead {
  category: 'SELLER_LEAD' | 'BUYER_ISO' | 'LANDLORD_LEAD' | 'RENTER_INQUIRY'
  clientSide: 'buyer' | 'seller' | 'landlord' | 'renter' | null
  neighborhood: string | null
  borough: string | null
  address: string | null
  price: number | null
  beds: number | null
  isHistoricalComp: boolean
  confidence: number
  summary: string
  reason: string
}

const RECOVERY_SYSTEM = `You are a lead-recovery pass for a NYC real estate agent's inbox. An upstream classifier already routed this email to an informational bucket (a client chat, market note, newsletter, or noise). Your ONLY job: decide whether a REAL, ACTIONABLE buyer/seller/landlord/renter lead is buried in it that the upstream pass missed.

Report a lead (found=true) ONLY when a real person expresses CONCRETE, ACTIONABLE, NEW intent — not an ongoing conversation. Pick the matching category:
- SELLER_LEAD (clientSide "seller") — owner states intent to LIST/SELL a specific property they own ("btw I'm thinking of listing my 2BR next month", "we're going to sell the Chelsea apartment in the spring"). Future intent counts.
- LANDLORD_LEAD (clientSide "landlord") — owner intends to rent their unit out.
- BUYER_ISO (clientSide "buyer") — a buyer with CONCRETE criteria: an actual neighborhood plus a budget or bed count specific enough to act on.
- RENTER_INQUIRY (clientSide "renter") — a renter with concrete criteria (neighborhood + monthly budget/beds).

DO NOT invent a lead. Set found=false for:
- Genuinely informational email: pure thank-yous with no future intent, market commentary, event invites, closing logistics, or unrelated chatter.
- An ONGOING conversation with an existing client that lacks NEW concrete criteria — e.g. "thanks for the showings, we loved the light but the kitchen was tight, let's talk about what's realistic in our range" is a continuation, NOT a new lead. Require real specifics (a property to list, or a neighborhood + budget/beds), otherwise found=false.
- A client reacting to or forwarding someone else's listing, or negotiating an already-live deal.

HISTORICAL / COMP GUARD: if the only deal-like content is a SOLD/closed comparable used for pricing context ("12 E 10th St just sold for $2.1M, great comp"), or a past personal purchase ("I paid $1.8M for my last place"), that is NOT a live lead. Set isHistoricalComp=true (and found=true only if you must surface it). Never present a closed comp as an active lead.

Be conservative: when in doubt, found=false. Never invent an address, price, or beds — use null if not stated.`

// Anthropic tool input schema (JSON-Schema).
const recoveryInputSchema = {
  type: 'object',
  properties: {
    found:            { type: 'boolean' },
    category:         { type: ['string', 'null'], enum: ['SELLER_LEAD', 'BUYER_ISO', 'LANDLORD_LEAD', 'RENTER_INQUIRY', null] },
    clientSide:       { type: ['string', 'null'], enum: ['buyer', 'seller', 'landlord', 'renter', null] },
    neighborhood:     { type: ['string', 'null'] },
    borough:          { type: ['string', 'null'] },
    address:          { type: ['string', 'null'] },
    price:            { type: ['number', 'null'] },
    beds:             { type: ['number', 'null'] },
    isHistoricalComp: { type: 'boolean' },
    confidence:       { type: 'number', minimum: 0, maximum: 1 },
    summary:          { type: 'string' },
    reason:           { type: 'string' },
  },
  required: ['found', 'category', 'clientSide', 'neighborhood', 'borough', 'address', 'price', 'beds', 'isHistoricalComp', 'confidence', 'summary', 'reason'],
} as Anthropic.Messages.Tool.InputSchema

const RecoverySchema = z.object({
  found:            z.boolean(),
  category:         z.enum(['SELLER_LEAD', 'BUYER_ISO', 'LANDLORD_LEAD', 'RENTER_INQUIRY']).nullable(),
  clientSide:       z.enum(['buyer', 'seller', 'landlord', 'renter']).nullable(),
  neighborhood:     z.string().nullable(),
  borough:          z.string().nullable(),
  address:          z.string().nullable(),
  price:            z.number().nullable(),
  beds:             z.number().nullable(),
  isHistoricalComp: z.boolean(),
  confidence:       z.number().min(0).max(1),
  summary:          z.string().nullish().transform(v => v ?? ''),
  reason:           z.string().nullish().transform(v => v ?? ''),
})

/**
 * Scan an informational-tone email for a buried, actionable lead. Returns null when
 * there is no concrete intent (the conservative default). The cost is one small
 * Sonnet call (~$0.003); callers should invoke it only for the informational
 * categories, not for every email.
 */
export async function recoverBuriedLead(context: string, ctx: MapCtx): Promise<RecoveredLead | null> {
  const userMessage = `Email subject: ${ctx.subject}\nFrom: ${ctx.senderName ?? 'Unknown'} <${ctx.senderEmail ?? 'unknown'}>\n\nScan the content below for a buried, actionable lead the upstream classifier may have missed.\n\n${context}`

  const result = await extractWithSonnet({
    systemPrompt:    RECOVERY_SYSTEM,
    userMessage,
    toolName:        'report_buried_lead',
    toolDescription: 'Report whether a buried, actionable buyer/seller/landlord/renter lead exists in this informational-looking email.',
    inputSchema:     recoveryInputSchema,
    zodSchema:       RecoverySchema,
    maxTokens:       400,
  })

  if (result.error || !result.data) return null
  const d = result.data
  // Conservative gate: require an explicit lead, a category, and real confidence.
  if (!d.found || !d.category || d.confidence < 0.6) return null

  return {
    category:         d.category,
    clientSide:       d.clientSide,
    neighborhood:     d.neighborhood,
    borough:          d.borough,
    address:          d.address,
    price:            d.price,
    beds:             d.beds,
    isHistoricalComp: d.isHistoricalComp,
    confidence:       d.confidence,
    summary:          d.summary,
    reason:           d.reason,
  }
}

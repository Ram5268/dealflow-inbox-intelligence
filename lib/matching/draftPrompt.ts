// Brief 41 (H7): the draft-outreach system prompt, pure so it can be tested.
// For a homeowner (contact supply) it never carries our estimate (#14's
// outreachPriceText), the homeowner's name or a seller-circumstance reason.
// Brief 43 PR 3b [Ryan, 2026-10-19]: nor the street address until the
// homeowner has agreed to sell (the ryan_listing tag): the home is described by
// area and type (buyerFacingSupply, applied here too, so no caller can skip it).
import type { ResolvedSupply } from './supplyResolver'
import { outreachPriceText } from './outreachPrice'
import { plainFitReason } from './fitReason'
import { buyerFacingSupply } from '../buyerFacingSupply'

export interface DraftParty {
  name: string
  role: string
  budget: string | null
  beds: string | null
  neighborhood: string | null
}

export function draftOutreachSystemPrompt(args: {
  channel: 'email' | 'text'
  party: DraftParty
  supply: ResolvedSupply
  matchReason: string | null
  counterpartType?: string
}): string {
  const { channel, party } = args
  const supply = buyerFacingSupply(args.supply)
  const listingAddress = supply.address ?? supply.extractedTitle // a homeowner's: area and type unless agreed to sell
  const areaOnly = supply.opportunityType === 'contact' && !supply.address
  const listingPrice = outreachPriceText(supply) // never our estimate for a seller contact
  const listingBeds = supply.beds ? `${supply.beds}BR` : 'beds n/a'
  // Either side can be a homeowner: legacy-engine rows with a Mojo contact
  // counterpart quote that contact's estimated value as a "budget".
  const reason = plainFitReason(args.matchReason, { homeowner: supply.opportunityType === 'contact' || args.counterpartType === 'mojo' })

  return `You are drafting a brief outreach ${channel} from a NYC real estate broker (Ryan Martin, Douglas Elliman) to a prospect. Match context:

Prospect: ${party.name} — ${party.role}
Their criteria: ${[party.budget, party.beds, party.neighborhood].filter(Boolean).join(' · ') || 'unspecified'}
Property: ${listingAddress} · ${listingBeds} · ${listingPrice}
Match reason: ${reason}

Draft ${channel === 'email' ? 'a subject line and a 2-3 sentence body' : 'a 2-3 sentence text'}.
Rules:
- Warm but not pushy
- Reference one specific detail from the property AND from their criteria
${areaOnly
    ? '- Describe the home only by its area and type, as given above: no street address, no house number. Include one specific number (beds) if given'
    : '- Include address + one specific number (price OR beds)'}
- End with an open question or soft invite ("worth a look?" / "shall I set up a showing?")
- Do NOT: use exclamation marks, say "act fast" or "urgent", assume prior conversation, over-promise

Return ONLY valid JSON: ${channel === 'email' ? '{ "subject": string, "body": string }' : '{ "body": string }'}`
}

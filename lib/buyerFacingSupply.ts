// Ryan's decision, 2026-10-17: saved seller notes may keep these details.
// Buyer-facing text still never names motivation (engineering precaution,
// Brief 41 H7).
//
// A seller or landlord lead's notes, and a client conversation's, may name an
// estate, a divorce, an illness or the like, in the title too. No matcher puts
// one on a match's supply side: they take SUPPLY_SALE / SUPPLY_RENTAL listings,
// and nightly scoring takes CRM homeowners (pinned by
// lib/__tests__/ownerNotesNeverSupply.test.ts). An old or odd Match row with
// one there anyway is shown to a buyer exactly like a homeowner: the address or
// "Homeowner in <neighborhood>", no price, no source, and the homeowner fit
// line. Display only: nothing that scores reads this.
import type { ResolvedSupply } from './matching/supplyResolver'
import { homeownerTitle } from './matching/fitReason'

const OWNER_NOTES: ReadonlySet<string> = new Set(['SELLER_LEAD', 'LANDLORD_LEAD', 'CLIENT_CONVERSATION'])

export function holdsOwnerNotes(category: string | null | undefined): boolean {
  return category != null && OWNER_NOTES.has(category)
}

// The supply as buyer-facing text may show it: unchanged, or (owner notes)
// shaped like a homeowner's. The report's and the draft's homeowner rules key
// on opportunityType 'contact', so this copy is for display, never for a lookup.
export function buyerFacingSupply(s: ResolvedSupply): ResolvedSupply {
  if (!holdsOwnerNotes(s.category)) return s
  return {
    ...s,
    opportunityType: 'contact',
    extractedTitle: homeownerTitle(s.address, s.neighborhood),
    price: null,
    minPrice: null,
    maxPrice: null,
    sourceBrokerage: null,
    sourceAgentName: null,
    availabilityDate: null,
  }
}

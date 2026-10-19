// Ryan's decision, 2026-10-17: saved seller notes may keep these details.
// Buyer-facing text still never names motivation (engineering precaution,
// Brief 41 H7).
//
// A seller or landlord lead's notes, and a client conversation's, may name an
// estate, a divorce, an illness or the like, in the title too. No matcher puts
// one on a match's supply side: they take SUPPLY_SALE / SUPPLY_RENTAL listings,
// and nightly scoring takes CRM homeowners (pinned by
// lib/__tests__/ownerNotesNeverSupply.test.ts). An old or odd Match row with
// one there anyway is shown to a buyer exactly like a homeowner: area and type,
// no price, no source, and the homeowner fit line. Display only: nothing that
// scores reads this.
//
// Brief 43 PR 3b [Ryan, 2026-10-19]: no street address in a note to a buyer or
// a buyer's agent until the homeowner has agreed to sell. A homeowner's home is
// described by area and type ("3-family in Bedford-Stuyvesant"); the only sign
// of "agreed to sell" today is the CRM's ryan_listing tag (Ryan's own listing,
// ResolvedSupply.agreedToSell). A lead from an email has no such tag, so never.
// Listings from emails or StreetEasy keep their addresses: they're public.
// Ryan's own screens (/matches, CRM cards) read the supply unchanged.
import type { ResolvedSupply } from './matching/supplyResolver'
import { listingPropertyClasses } from './matching/propertyTypes'

const OWNER_NOTES: ReadonlySet<string> = new Set(['SELLER_LEAD', 'LANDLORD_LEAD', 'CLIENT_CONVERSATION'])

export function holdsOwnerNotes(category: string | null | undefined): boolean {
  return category != null && OWNER_NOTES.has(category)
}

// The home's type in a buyer's words: "3-family", "Townhouse", else "Home".
function homeType(text: string | null, units: number | null): string {
  const cls = listingPropertyClasses({ propertyType: text, propertyTypeDetail: null, unitCount: units })
  const n = units != null && units >= 2 ? Math.round(units) : null
  if (cls.has('mixed_use')) return 'Mixed-use building'
  if (cls.has('condo')) return 'Condo'
  if (cls.has('coop')) return 'Co-op'
  if (cls.has('multifamily')) return n == null ? 'Multi-family' : n <= 4 ? `${n}-family` : `${n}-unit building`
  if (cls.has('townhouse')) return 'Townhouse'
  if (cls.has('single_family')) return 'Single-family home'
  if (cls.has('land')) return 'Lot'
  if (cls.has('commercial')) return 'Commercial property'
  return 'Home'
}

// [Ryan, 2026-10-19] A homeowner's home by area and type, never the street
// address: "3-family in Bedford-Stuyvesant", "Home in Brooklyn", "Home".
export function homeAreaAndType(s: Pick<ResolvedSupply, 'neighborhood' | 'borough' | 'propertyTypeText' | 'unitCount'>): string {
  const area = s.neighborhood?.trim() || s.borough?.trim()
  const type = homeType(s.propertyTypeText, s.unitCount)
  return area ? `${type} in ${area}` : type
}

// A homeowner's place as a buyer may see it: the address only once they have
// agreed to sell, else area and type.
function homeownerPlace(s: ResolvedSupply, agreedToSell: boolean): Pick<ResolvedSupply, 'address' | 'extractedTitle'> {
  const address = agreedToSell ? s.address?.trim() || null : null
  return { address, extractedTitle: address ?? homeAreaAndType(s) }
}

// The supply as buyer-facing text may show it: a listing unchanged; a CRM
// homeowner without its address (above); owner notes shaped like a homeowner's.
// The report's and the draft's homeowner rules key on opportunityType
// 'contact', so this copy is for display, never for a lookup. Applying it twice
// gives the same result.
export function buyerFacingSupply(s: ResolvedSupply): ResolvedSupply {
  if (s.opportunityType === 'contact') return { ...s, ...homeownerPlace(s, s.agreedToSell) }
  if (!holdsOwnerNotes(s.category)) return s
  return {
    ...s,
    opportunityType: 'contact',
    ...homeownerPlace(s, false),
    agreedToSell: false,
    price: null,
    minPrice: null,
    maxPrice: null,
    sourceBrokerage: null,
    sourceAgentName: null,
    availabilityDate: null,
  }
}

import { Category } from '@prisma/client'
// Relative (not '@/') so the ts-node test runner resolves it — the test harness
// doesn't register tsconfig path aliases.
import { SUPPLY_SALE, SUPPLY_RENTAL } from '../domain/Categories'

const SUPPLY_SET = new Set<Category>([...SUPPLY_SALE, ...SUPPLY_RENTAL])

// Brief 8.0-lite Fix #3a — resolve a Match's (partyId, listingId) dismissal key.
//
// A Match row stores (opportunityId, counterpartId). Which side is the SUPPLY
// listing and which is the DEMAND party is NOT implied by the field name: the
// Brief 7.0 engine puts whichever side triggered the run into opportunityId. So
// a BUYER_ISO / RENTER_INQUIRY lands in opportunityId whenever the party was the
// trigger (see lib/backgroundSync.ts runEngineMatches).
//
// MatchDismissal keys on (partyId=demand, listingId=supply), and the engine's
// own candidate filter (lib/matching/engine.ts loadDismissedKeys) uses that same
// convention. Resolving from CATEGORY — not from field name — is what keeps the
// dismiss write, the GET /api/matches exclusion, and the engine filter all
// agreeing on the same key. The pre-8.0 code assumed partyId=counterpartId
// unconditionally, so ISO-triggered dismissals were stored inverted and the
// engine kept re-surfacing them.
//
// counterpartType 'mojo' is always a demand party today (opp is the supply
// listing → SUPPLY branch). The non-supply branch future-proofs a Mojo listing.
// showing_confirmation self-matches have opportunityId === counterpartId, so the
// key is the same pair either way.
//
// Brief 35: opportunityType 'contact' means opportunityId is a seller MojoContact,
// i.e. always the supply side, whatever its (null) category.
export function resolveDismissKey(match: {
  opportunityId: string
  counterpartId: string
  opportunityType: string
  opportunityCategory: Category | null
}): { partyId: string; listingId: string } {
  const supplyIsOpportunity = match.opportunityType === 'contact' ||
    (match.opportunityCategory != null && SUPPLY_SET.has(match.opportunityCategory))
  return supplyIsOpportunity
    ? { partyId: match.counterpartId, listingId: match.opportunityId }
    : { partyId: match.opportunityId, listingId: match.counterpartId }
}

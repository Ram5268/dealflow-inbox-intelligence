// Brief 48 (PR 15, item 4.13; Brief 40 audit D4-18): the Match rows that point at a
// listing (an ExtractedOpportunity), so code that deletes listings deletes their
// matches with them. Brief 32 dropped the Match → ExtractedOpportunity foreign key
// (a match's supply side can now be a CRM contact), so nothing cascades: every
// re-extract, reclassify-as-noise and buried-lead re-run left "orphaned" matches that
// still showed on /matches, in the counts and on the CRM's seller cards
// [engineering precaution].
//
// A match points at a listing on either side:
// - the supply side: opportunityId, when opportunityType is 'opportunity'
//   ('contact' means opportunityId is a CRM contact);
// - the other side: counterpartId, when counterpartType is 'opportunity' (a buyer or
//   renter request, or a listing) or 'showing_confirmation' (lib/backgroundSync.ts
//   stores the showing's own listing id on both sides). 'mojo' is a CRM contact.
import type { Prisma } from '@prisma/client'

export const LISTING_COUNTERPART_TYPES: readonly string[] = ['opportunity', 'showing_confirmation']

export function matchesOfListings(listingIds: string[]): Prisma.MatchWhereInput {
  return {
    OR: [
      { opportunityType: 'opportunity', opportunityId: { in: listingIds } },
      { counterpartType: { in: [...LISTING_COUNTERPART_TYPES] }, counterpartId: { in: listingIds } },
    ],
  }
}

type ListingDb = Pick<Prisma.TransactionClient, 'extractedOpportunity' | 'match'>

// Deletes the listings `where` selects and every match that points at them. Pass a
// transaction client (prisma.$transaction(tx => …)), so both go or neither does.
export async function deleteListingsAndMatches(
  db: ListingDb,
  where: Prisma.ExtractedOpportunityWhereInput,
): Promise<{ listings: number; matches: number }> {
  const ids = (await db.extractedOpportunity.findMany({ where, select: { id: true } })).map(r => r.id)
  if (ids.length === 0) return { listings: 0, matches: 0 }
  const { count: matches } = await db.match.deleteMany({ where: matchesOfListings(ids) })
  const { count: listings } = await db.extractedOpportunity.deleteMany({ where: { id: { in: ids } } })
  return { listings, matches }
}

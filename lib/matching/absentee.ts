// Brief 41 — one absentee-owner test for every feature that asks.
//
// `ownerOccupied` wins when it's known: the CRM sync computes it from the mailing
// vs property street and city (crm-sync/addressNormalize.ts). Only when it's null
// do we compare the mailing street with the property street ourselves, normalised
// the same way. A raw string compare never matched a CRM mailing address
// ("88 Example Street, Brooklyn, NY" vs "88 Example St # 3"), so every CRM seller
// with a mailing address looked absentee.
import { normalizeStreet } from '../crm-sync/addressNormalize'
import type { ListingData } from './scorerTypes'

const streetOf = (address: string | null): string | null => normalizeStreet(address?.split(',')[0])

// true: absentee owner. false: owner lives there. null: unknown. Streets only:
// ListingData has no property city (CRM rows already carry ownerOccupied, which
// the sync computed from street AND city). A mailing address with no property
// street counts as absentee, as in the CRM rule.
export function isAbsenteeOwner(listing: Pick<ListingData, 'ownerOccupied' | 'address' | 'alternateAddress'>): boolean | null {
  if (listing.ownerOccupied != null) return !listing.ownerOccupied
  const mailing = streetOf(listing.alternateAddress)
  if (!mailing) return null
  return mailing !== streetOf(listing.address)
}

// Brief 41 — one absentee-owner test for every feature that asks.
//
// `ownerOccupied` wins when it's known: the CRM sync computes it from the mailing
// vs property street and city (crm-sync/addressNormalize.ts). Only when it's null
// do we compare the mailing street with the property street ourselves, normalised
// the same way. A raw string compare never matched a CRM mailing address
// ("361 Degraw Street, Brooklyn, NY" vs "361 Degraw St # 3"), so every CRM seller
// with a mailing address looked absentee.
import { normalizeStreet } from '../crm-sync/addressNormalize'
import type { ListingData } from './scorerTypes'

const streetOf = (address: string | null): string | null => normalizeStreet(address?.split(',')[0])

// true: absentee owner. false: owner lives there. null: unknown.
export function isAbsenteeOwner(listing: Pick<ListingData, 'ownerOccupied' | 'address' | 'alternateAddress'>): boolean | null {
  if (listing.ownerOccupied != null) return !listing.ownerOccupied
  const mailing = streetOf(listing.alternateAddress)
  if (!mailing) return null
  const property = streetOf(listing.address)
  return property ? mailing !== property : null
}

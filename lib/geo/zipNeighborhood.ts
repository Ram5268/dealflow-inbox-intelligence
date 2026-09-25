import { fromRaw } from '../domain/Neighborhood'

// Brief 34: NYC ZIP → neighborhood, shared by the CRM lead sync and (until
// PR B deletes them) app/api/mojo/{process,webhook}. Values are raw lowercase
// names; zipToNeighborhood canonicalizes them with fromRaw. ZIPs that span
// several neighborhoods (11207, 11232, 11218) are deliberately unmapped.
export const NYC_ZIP_NEIGHBORHOODS: Record<string, string> = {
  '10013': 'tribeca', '10007': 'tribeca', '10012': 'soho', '10014': 'west village',
  '10011': 'chelsea', '10001': 'chelsea', '10010': 'gramercy', '10003': 'east village',
  '10002': 'lower east side', '10004': 'financial district', '10006': 'financial district',
  '10005': 'financial district', '10280': 'battery park city', '10023': 'upper west side',
  '10024': 'upper west side', '10025': 'upper west side', '10021': 'upper east side',
  '10022': 'upper east side', '10065': 'upper east side', '10075': 'upper east side',
  '10128': 'upper east side', '10029': 'east harlem', '10035': 'east harlem',
  '11201': 'brooklyn heights', '11231': 'carroll gardens', '11217': 'park slope',
  '11215': 'park slope', '11238': 'prospect heights', '11216': 'crown heights',
  '11221': 'bushwick', '11206': 'williamsburg', '11211': 'williamsburg',
  '11222': 'greenpoint', '11205': 'fort greene', '11233': 'bed-stuy',
  '11213': 'crown heights', '11225': 'flatbush',
  // Added for the CRM's leads (Brief 34)
  '11385': 'ridgewood', '11237': 'bushwick', '11220': 'sunset park', '11378': 'maspeth',
  '11249': 'williamsburg', '11219': 'borough park', '11226': 'flatbush',
}

// Exact 5-digit lookup (ZIP+4 accepted), canonical name or null.
export function zipToNeighborhood(zip: string | null | undefined): string | null {
  const zip5 = zip?.trim().match(/^\d{5}/)?.[0]
  return zip5 ? fromRaw(NYC_ZIP_NEIGHBORHOODS[zip5]) : null
}

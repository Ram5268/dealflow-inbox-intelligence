import { fromRaw, getBorough, type NeighborhoodMeta } from '../domain/Neighborhood'

export type Borough = NeighborhoodMeta['borough']

// Brief 35: borough-level location for areas whose label isn't a known
// neighborhood (e.g. plain "Brooklyn"). Stored labels are never rewritten;
// this is read-only derivation for the scorer.
const BOROUGH_LABELS: Record<string, Borough> = {
  manhattan: 'Manhattan', brooklyn: 'Brooklyn', queens: 'Queens', bronx: 'Bronx', 'the bronx': 'Bronx',
  'staten island': 'Staten Island',
}
const ZIP_PREFIX: Record<string, Borough> = {
  '100': 'Manhattan', '101': 'Manhattan', '102': 'Manhattan', '103': 'Staten Island', '104': 'Bronx',
  '112': 'Brooklyn', '110': 'Queens', '111': 'Queens', '113': 'Queens', '114': 'Queens', '116': 'Queens',
}

// A label that is exactly a borough name (case-insensitive), not a neighborhood.
export function boroughFromLabel(label: string | null | undefined): Borough | null {
  return BOROUGH_LABELS[label?.trim().toLowerCase() ?? ''] ?? null
}

export function boroughFromZip(zip: string | null | undefined): Borough | null {
  const prefix = zip?.trim().match(/^\d{5}/)?.[0].slice(0, 3)
  return prefix ? ZIP_PREFIX[prefix] ?? null : null
}

// Seller borough: the canonical neighborhood's borough, else the ZIP prefix,
// else a borough-name label.
export function listingBorough(neighborhood: string | null, zip: string | null): Borough | null {
  const canonical = fromRaw(neighborhood)
  if (canonical) return getBorough(canonical)
  return boroughFromZip(zip) ?? boroughFromLabel(neighborhood)
}

// Buyer areas given as borough names ("Brooklyn", "The Bronx").
export function boroughLabels(areas: string[]): string[] {
  return areas.filter(a => !fromRaw(a)).map(boroughFromLabel).filter((b): b is Borough => b !== null)
}

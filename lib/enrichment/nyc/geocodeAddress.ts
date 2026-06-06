// Phase 4.6 — NYC GeoSearch v2 geocoder. Unauthenticated. Returns the BBL
// (Borough-Block-Lot) for an address, which is the join key into PLUTO + ACRIS.
//   BBL path: features[0].properties.addendum.pad.bbl
// Confidence floor 0.7 for auto-storage; optional borough cross-check guards the
// known "Bay Street Staten Island returns Bronx" failure mode.
import { getJson } from './socrataClient'

const GEOSEARCH_URL = 'https://geosearch.planninglabs.nyc/v2/search'
const CONFIDENCE_FLOOR = 0.7

// First BBL digit → borough (1 Manhattan, 2 Bronx, 3 Brooklyn, 4 Queens, 5 SI)
const BBL_BOROUGH: Record<string, string> = {
  '1': 'manhattan', '2': 'bronx', '3': 'brooklyn', '4': 'queens', '5': 'staten island',
}
export function boroughFromBbl(bbl: string | null | undefined): string | null {
  if (!bbl) return null
  return BBL_BOROUGH[bbl.trim()[0]] ?? null
}

interface GeoFeature {
  properties?: {
    confidence?: number
    label?: string
    addendum?: { pad?: { bbl?: string; bin?: string } }
  }
  geometry?: { coordinates?: [number, number] } // [lng, lat]
}
interface GeoResponse { features?: GeoFeature[] }

export type GeocodeRejectReason = 'no_results' | 'low_confidence' | 'no_bbl' | 'wrong_borough' | 'unreachable' | 'number_mismatch'

export interface GeocodeResult {
  bbl: string | null
  bin: string | null
  borough: string | null
  confidence: number | null
  label: string | null
  lat: number | null
  lng: number | null
  rejectReason: GeocodeRejectReason | null
}

function bblOf(f: GeoFeature): string | null {
  return f.properties?.addendum?.pad?.bbl ?? null
}

// Leading building number of an address/label. Keeps a trailing letter (49A) and
// a Queens-style hyphen range (3-18) so they compare faithfully.
function leadingStreetNumber(s: string): string | null {
  const m = s.trim().match(/^(\d+[A-Za-z]?(?:-\d+)?)\b/)
  return m ? m[1] : null
}

/**
 * Geocode an address to a BBL via NYC GeoSearch v2.
 * @param query           the address text to resolve
 * @param expectedBorough canonical lowercase borough (manhattan|brooklyn|queens|bronx|staten island)
 *                        or null to skip the cross-check
 */
export async function geocodeAddress(query: string, expectedBorough?: string | null): Promise<GeocodeResult> {
  const empty: GeocodeResult = {
    bbl: null, bin: null, borough: null, confidence: null, label: null, lat: null, lng: null, rejectReason: null,
  }
  const url = `${GEOSEARCH_URL}?text=${encodeURIComponent(query)}&size=5`
  const res = await getJson<GeoResponse>(url) // GeoSearch is unauthenticated — no isSocrata flag
  // null = network error after getJson's retries. This is NOT a definitive
  // "no results" — distinguish it so the caller doesn't stamp a permanent null.
  if (res === null) return { ...empty, rejectReason: 'unreachable' }
  const features = res.features ?? []
  if (features.length === 0) return { ...empty, rejectReason: 'no_results' }

  // Borough cross-check: if we expect a borough, restrict candidates to features
  // whose BBL-derived borough matches. If none match → wrong_borough.
  let candidates = features
  if (expectedBorough) {
    const matching = features.filter(f => boroughFromBbl(bblOf(f)) === expectedBorough)
    if (matching.length === 0) return { ...empty, rejectReason: 'wrong_borough' }
    candidates = matching
  }

  const top = candidates[0]
  const confidence = top.properties?.confidence ?? 0
  const label = top.properties?.label ?? null
  const coords = top.geometry?.coordinates ?? null
  const lng = coords ? coords[0] : null
  const lat = coords ? coords[1] : null

  if (confidence < CONFIDENCE_FLOOR) {
    return { ...empty, confidence, label, lat, lng, rejectReason: 'low_confidence' }
  }
  const bbl = bblOf(top)
  if (!bbl) {
    return { ...empty, confidence, label, lat, lng, rejectReason: 'no_bbl' }
  }
  // Building-number cross-check: reject when GeoSearch's matched street number
  // differs from the input's — a unit number that leaked into the query, or a
  // fuzzy street-name fallback, lands on the wrong building. Trailing letters are
  // ignored (49A≈49); Queens hyphen ranges compare whole (3-18 vs 3-18).
  const inputNum = leadingStreetNumber(query)
  const matchedNum = leadingStreetNumber(label ?? '')
  if (inputNum && matchedNum) {
    const inputBase = inputNum.replace(/[A-Za-z]+$/, '')
    const matchedBase = matchedNum.replace(/[A-Za-z]+$/, '')
    if (inputBase !== matchedBase) {
      return { ...empty, confidence, label, lat, lng, rejectReason: 'number_mismatch' }
    }
  }
  return {
    bbl,
    bin: top.properties?.addendum?.pad?.bin ?? null,
    borough: boroughFromBbl(bbl),
    confidence,
    label,
    lat,
    lng,
    rejectReason: null,
  }
}

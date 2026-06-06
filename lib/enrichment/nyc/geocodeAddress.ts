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

// First building-number token of an address/label — at the start OR after
// whitespace/comma. Tolerates a building-name or apt prefix ("The Plaza, 768 …",
// "Apt 5A, 740 …") so the number-mismatch net isn't silently skipped when the
// number isn't front-anchored. Keeps a trailing letter (49A) and a Queens-style
// hyphen range (3-18).
export function firstStreetNumber(s: string): string | null {
  const m = s.trim().match(/(?:^|[\s,])(\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?)\b/)
  return m ? m[1] : null
}

// True when an input building number and GeoSearch's matched number refer to the
// same parcel: exact (trailing letters ignored, 49A≈49), or a single number
// contained in the other's hyphen range (44-50 ⊇ 44) — GeoSearch frequently
// returns the low end for a range-addressed building.
export function streetNumbersCompatible(inputNum: string, matchedNum: string): boolean {
  const strip = (s: string) => s.replace(/[A-Za-z]+$/, '')
  const a = strip(inputNum), b = strip(matchedNum)
  if (a === b) return true
  const asRange = (s: string): [number, number] | null => {
    const m = s.match(/^(\d+)-(\d+)$/)
    if (!m) return null
    const lo = parseInt(m[1], 10), hi = parseInt(m[2], 10)
    return [Math.min(lo, hi), Math.max(lo, hi)]
  }
  const asSingle = (s: string): number | null => (/^\d+$/.test(s) ? parseInt(s, 10) : null)
  const ra = asRange(a), sb = asSingle(b)
  if (ra && sb != null && sb >= ra[0] && sb <= ra[1]) return true
  const rb = asRange(b), sa = asSingle(a)
  if (rb && sa != null && sa >= rb[0] && sa <= rb[1]) return true
  return false
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
  // is incompatible with the input's — a unit number that leaked into the query,
  // or a fuzzy street-name fallback, lands on the wrong building. Tolerates
  // building-name/apt prefixes (firstStreetNumber) and hyphen ranges
  // (streetNumbersCompatible: 44-50 ⊇ 44).
  const inputNum = firstStreetNumber(query)
  const matchedNum = firstStreetNumber(label ?? '')
  if (inputNum && matchedNum && !streetNumbersCompatible(inputNum, matchedNum)) {
    return { ...empty, confidence, label, lat, lng, rejectReason: 'number_mismatch' }
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

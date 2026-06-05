// Phase 4.6 — PLUTO (Primary Land Use Tax Lot Output) via Socrata 64uk-42ks.
// Lookup by numeric BBL; we read `bldgclass` (the DOF building class) plus
// `ownername` (for the co-op-corp heuristic) and a few descriptive fields.
import { getJson } from './socrataClient'

const PLUTO_URL = 'https://data.cityofnewyork.us/resource/64uk-42ks.json'
const SELECT = 'bbl,bldgclass,ownername,unitsres,unitstotal,yearbuilt,borough,zipcode,address,version'

// Socrata returns numbers as JSON strings; keep them as-is and parse on demand.
export interface PlutoRecord {
  bbl: string
  bldgclass: string | null
  ownername: string | null
  unitsres: string | null
  unitstotal: string | null
  yearbuilt: string | null
  borough: string | null
  zipcode: string | null
  address: string | null
  version: string | null
}

// Distinguish "found / verified-not-found" (record / null) from a transient
// network failure (unreachable=true), so the caller can stamp pluto_no_record
// vs pluto_unreachable — per the rail "5xx/network must NOT be treated as no-data".
export interface PlutoLookup { record: PlutoRecord | null; unreachable: boolean }

/** Look up a parcel in PLUTO by BBL. */
export async function lookupPluto(bbl: string): Promise<PlutoLookup> {
  // BBL is numeric in PLUTO — strip any leading zeros (boro digit is 1-5 so this
  // is a no-op in practice, but guards against a zero-padded input).
  const numericBbl = String(parseInt(bbl, 10))
  if (numericBbl === 'NaN') return { record: null, unreachable: false }
  const url = `${PLUTO_URL}?bbl=${numericBbl}&$select=${encodeURIComponent(SELECT)}`
  const rows = await getJson<PlutoRecord[]>(url, { isSocrata: true })
  if (rows === null) return { record: null, unreachable: true } // network error — not "no record"
  return { record: rows[0] ?? null, unreachable: false }
}

// Phase 4.6 — ACRIS condo-declaration check via Socrata (two-step; Socrata has
// no cross-dataset JOINs):
//   Step 1  Legals 8h5j-fqxa: BBL → document_id list
//   Step 2  Master bnx9-e6tj: count of CDEC/ADEC (Condo/Amended Condo
//           Declaration) docs among those document_ids
// Only ever called for PLUTO codes ambiguous between rental multi-family and a
// condo conversion (C*/D* minus C6/C8/D0/D4). Returns:
//   true  → a condo declaration exists  (→ condo)
//   false → verified none / no legals    (→ keep PLUTO class)
//   null  → network error                (→ keep PLUTO class, lower confidence)
import { getJson } from './socrataClient'

const LEGALS_URL = 'https://data.cityofnewyork.us/resource/8h5j-fqxa.json'
const MASTER_URL = 'https://data.cityofnewyork.us/resource/bnx9-e6tj.json'

interface LegalRow { document_id?: string }
interface CountRow { cnt?: string }

/** Split a 10-digit BBL into ACRIS borough / block / lot components. */
export function splitBbl(bbl: string): { boro: number; block: number; lot: number } | null {
  const s = bbl.trim()
  if (s.length < 10) return null
  const boro = parseInt(s[0], 10)
  const block = parseInt(s.slice(1, 6), 10)
  const lot = parseInt(s.slice(6, 10), 10)
  if ([boro, block, lot].some(n => Number.isNaN(n))) return null
  return { boro, block, lot }
}

export async function hasCondoDeclaration(bbl: string): Promise<boolean | null> {
  const parts = splitBbl(bbl)
  if (!parts) return false // can't form the query → treat as "no declaration found"
  const { boro, block, lot } = parts

  // Step 1 — Legals: document_ids at this parcel. borough/block/lot are numeric
  // columns in 8h5j-fqxa, so they are compared unquoted.
  const where1 = `borough=${boro} AND block=${block} AND lot=${lot}`
  const legalsUrl = `${LEGALS_URL}?$select=document_id&$where=${encodeURIComponent(where1)}&$limit=500`
  const legals = await getJson<LegalRow[]>(legalsUrl, { isSocrata: true })
  if (legals === null) return null // network error
  const ids = [...new Set(legals.map(r => r.document_id).filter((x): x is string => !!x))]
  if (ids.length === 0) return false // no recorded docs → no declaration

  // Step 2 — Master: count CDEC/ADEC among those document_ids. document_id is text.
  const idList = ids.map(id => `'${id.replace(/'/g, "''")}'`).join(',')
  const where2 = `doc_type IN ('CDEC','ADEC') AND document_id IN (${idList})`
  const masterUrl = `${MASTER_URL}?$select=count(*) as cnt&$where=${encodeURIComponent(where2)}`
  const counted = await getJson<CountRow[]>(masterUrl, { isSocrata: true })
  if (counted === null) return null // network error
  const cnt = parseInt(counted[0]?.cnt ?? '0', 10)
  return cnt > 0
}

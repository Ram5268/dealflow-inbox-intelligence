// Phase 4.6 — Orchestrator: deterministic propertyType from NYC public data.
//   short-circuits → GeoSearch (BBL) → air-rights guard → PLUTO (bldgclass) →
//   conditional ACRIS condo-declaration override.
// Every path produces (propertyType, propertyTypeReason); reason is NEVER null.
// We NEVER guess: unresolvable inputs return propertyType=null + a traceable reason.
import { normalizeAddress } from '../../domain/Address'
import { geocodeAddress, type GeocodeResult } from './geocodeAddress'
import { lookupPluto, type PlutoRecord } from './lookupPluto'
import { hasCondoDeclaration, splitBbl } from './lookupAcris'
import { classifyBuildingClass, looksLikeCoopOwner } from './bldgClassToType'
import { readCache, writeCache } from './cache'

export interface EnrichableOpportunity {
  category:        string
  address:         string | null
  state?:          string | null
  borough?:        string | null
  neighborhood?:   string | null
  propertyTypes?:  string[] | null
  organizationId:  string
}

export interface EnrichmentResult {
  propertyType:       string | null
  propertyTypeReason: string
  confidence:         string // high | medium | low | skip | cached
}

// Demand-side (criteria, not a parcel) + categories with no property address.
const SKIP_CATEGORIES = new Set([
  'BUYER_ISO', 'RENTER_INQUIRY',
  'MARKET_REPORT', 'REAL_ESTATE_EVENT', 'CLIENT_CONVERSATION', 'SHOWING_CONFIRMATION', 'NOISE',
])

// Whole-string address placeholders the LLM emits when it has no real address.
const PLACEHOLDER_ADDRESS =
  /^\s*(tbd|tba|n\/?a|none|null|unknown|various|multiple|several|private|undisclosed|confidential|(address )?withheld|address (tbd|upon request|withheld)|(contact|call|ask)( (me|us|the )?(agent|broker|listing agent|for (address|details|more)))?|to be (determined|announced)|off[- ]?market|[—–\-.?·•]+)\s*$/i

// Phase 4.6.3 — SUBSTRING placeholder patterns. The whole-string regex above
// misses "TBD - Hudson Yards" / "Various, Brooklyn" etc., which the LLM emits with
// extra text and which then fuzzy-geocode to a real (wrong) landmark. Any address
// CONTAINING one of these tokens is a placeholder, not a resolvable parcel.
const PLACEHOLDER_SUBSTRINGS = [
  /\btbd\b/i, /\btba\b/i, /\bvarious\b/i, /\bcoming soon\b/i,
  /\bcall for (?:address|details)\b/i, /\baddress upon request\b/i, /\bmultiple addresses?\b/i,
]
function isPlaceholderAddress(addr: string): boolean {
  return PLACEHOLDER_SUBSTRINGS.some(re => re.test(addr))
}

// Canonical borough names; aliases included. Generic "New York"/"NYC" are valid
// (in-NYC) but too ambiguous to use for the borough cross-check.
const BOROUGH_CANONICAL: Record<string, string> = {
  manhattan: 'manhattan', mn: 'manhattan',
  brooklyn: 'brooklyn', kings: 'brooklyn', bk: 'brooklyn', bklyn: 'brooklyn',
  queens: 'queens', qn: 'queens', qns: 'queens',
  bronx: 'bronx', 'the bronx': 'bronx', bx: 'bronx',
  'staten island': 'staten island', richmond: 'staten island', si: 'staten island',
}
const GENERIC_NYC = new Set(['new york', 'new york city', 'nyc', 'ny', 'n.y.', 'n.y.c.'])

function isNyState(state: string): boolean {
  const s = state.trim().toLowerCase().replace(/\./g, '')
  return s === 'ny' || s === 'new york'
}
function boroughForCrossCheck(raw: string): string | null {
  return BOROUGH_CANONICAL[raw.trim().toLowerCase()] ?? null
}
function isNycBorough(raw: string): boolean {
  const s = raw.trim().toLowerCase()
  return !!BOROUGH_CANONICAL[s] || GENERIC_NYC.has(s)
}
function titleCase(s: string): string {
  return s.replace(/\b\w/g, c => c.toUpperCase())
}
function toInt(v: string | null | undefined): number | null {
  if (v == null) return null
  const n = parseInt(v, 10)
  return Number.isNaN(n) ? null : n
}

// Strip a unit so it can't leak into the GeoSearch query and match the wrong
// building (e.g. "49 East 21 Street 11D" → "11 East 21 Street"). Covers, in
// rough parity with lib/domain/Address.ts UNIT_PATTERNS:
//   - a FRONT-anchored marker ("Apt 5A, 740 Park Avenue" → "740 Park Avenue")
//   - explicit trailing markers (apt / apartment / unit / #)
//   - floor markers ("Fl 5", "Floor 12")
//   - bare studio / penthouse / loft (optionally + number)
//   - slash duplex units ("11E/12F", "5/6F")
//   - a street-suffix followed by a bare alphanumeric unit ("Avenue 21B")
//   - a comma-prefixed unit (", 2F")
// Deliberately NO last-ditch fallback — it must not eat a legitimate street number.
export function stripBareUnitSuffix(addr: string): string {
  if (!addr) return addr
  return addr
    // FRONT-anchored apt/unit marker before the real address ("Apt 5A, 740 …")
    .replace(/^\s*(?:apt|apartment|unit|#)\s*[\w-]+\s*,\s*/i, '')
    // Explicit trailing unit markers (apt / apartment / unit / #)
    .replace(/,?\s+(?:apt|apartment|unit|#)\s*[\w-]+\s*$/i, '')
    // Floor markers ("Fl 5", "Floor 12", "Flr 3")
    .replace(/,?\s+(?:floor|flr|fl)\.?\s*\d+[a-z]?\s*$/i, '')
    // Bare studio / penthouse / loft (optionally + number)
    .replace(/,?\s+(?:studio|penthouse|loft)(?:\s+\d+[a-z]?)?\s*$/i, '')
    // Ordinal-then-floor ("14th Floor", "3 Fl", "2nd Flr")
    .replace(/,?\s+\d+(?:st|nd|rd|th)?\s+(?:floor|flr|fl)\.?\s*$/i, '')
    // Slash duplex units ("11E/12F", "5/6F")
    .replace(/[,\s]+\d{1,3}[a-z]?\/\d{1,3}[a-z]?\s*$/i, '')
    // Street suffix + bare alphanumeric unit ("street 11d", "avenue 21b")
    .replace(/\b(street|avenue|ave|st|road|rd|boulevard|blvd|place|pl|drive|dr|way|lane|ln|terrace|court|ct|parkway|pkwy)\.?\s+(\d{1,3}[a-z]|ph[0-9a-z]?|[a-z]\d{1,2})\s*$/i, '$1')
    // Trailing ", 21B" or ", 2F"
    .replace(/,\s*(\d{1,3}[a-z]|ph[0-9a-z]?|[a-z]\d{1,2})\s*$/i, '')
    // ── Phase 4.6.3 — additional coverage from the Step-4 audit ──
    // #APT / APT / UNIT marker mid/end ("740 Park Avenue #APT 18C")
    .replace(/\s*#?\s*(?:apt|apartment|unit)\s+[a-z0-9-]+\s*$/i, '')
    // Unit-prefix words: DUPLEX-N / TRIPLEX / GARDEN ("99 John Street DUPLEX-N")
    .replace(/\s+(?:duplex|triplex|loft|penthouse|garden)-?[a-z0-9]*\s*$/i, '')
    // Bare 3-4 digit trailing unit, only after a full street ("200 East 21st Street 808")
    .replace(/^(\d+\s+\w+(?:\s+\w+)*(?:\s+(?:street|avenue|ave|st|road|rd|blvd|place|pl|dr|way|lane|ln))?)\s+(\d{3,4})\s*$/i, '$1')
    // LAST-DITCH: a trailing unit-shaped alphanumeric token on a named street
    // without a standard suffix word ("41 Central Park West 12A"). Runs last so it
    // can't pre-empt the more specific patterns above. Gated by the smoke guards
    // ("100 14th Street", "500 5th Avenue", "Avenue C" must NOT strip).
    .replace(/\s+(\d{1,3}[a-z]|ph[0-9a-z]?|[a-z]\d{1,2})\s*$/i, ' ')
    .trim()
}

function skip(reason: string): EnrichmentResult {
  return { propertyType: null, propertyTypeReason: reason, confidence: 'skip' }
}

// Transient (network) failure: null + reason, but deliberately NOT cached, so a
// re-run re-attempts the lookup rather than memoizing a blip. The distinct
// reason prefix (geosearch_unreachable / pluto_unreachable) keeps these rows
// identifiable + re-runnable, honoring the rail "5xx/network must NOT be treated
// as no-data" (a definitive no_results/pluto_no_record would never be retried).
function transient(reason: string): EnrichmentResult {
  return { propertyType: null, propertyTypeReason: reason, confidence: 'transient' }
}

/** Terminal path from geocode onward: persist to cache (rejections too) and return. */
async function finish(
  key: string,
  orgId: string,
  geo: GeocodeResult,
  pluto: PlutoRecord | null,
  propertyType: string | null,
  hasCondoDecl: boolean | null,
  reason: string,
  confidence: string,
): Promise<EnrichmentResult> {
  try {
    await writeCache({
      normalizedAddress:   key,
      organizationId:      orgId,
      bbl:                 geo.bbl,
      bin:                 geo.bin,
      borough:             geo.borough,
      geosearchConfidence: geo.confidence,
      geosearchLabel:      geo.label,
      latitude:            geo.lat,
      longitude:           geo.lng,
      bldgclass:           pluto?.bldgclass ?? null,
      ownername:           pluto?.ownername ?? null,
      unitsRes:            toInt(pluto?.unitsres),
      unitsTotal:          toInt(pluto?.unitstotal),
      yearBuilt:           toInt(pluto?.yearbuilt),
      plutoVersion:        pluto?.version ?? null,
      hasCondoDecl,
      propertyType,
      propertyTypeReason:  reason,
      confidence,
    })
  } catch (e) {
    // Cache is an optimization; never lose the computed answer over a cache blip.
    console.error(`[nyc-enrich] cache write failed for "${key}": ${(e as Error).message}`)
  }
  return { propertyType, propertyTypeReason: reason, confidence }
}

export async function resolvePropertyType(opp: EnrichableOpportunity): Promise<EnrichmentResult> {
  const category = String(opp.category ?? '')

  // 1. Demand-side / non-property categories — never enriched.
  if (SKIP_CATEGORIES.has(category)) return skip('skipped:demand_or_non_property_category')

  // 2. Outside NYC by explicit state or non-NYC borough (BEFORE any HTTP call).
  const state = (opp.state ?? '').trim()
  if (state && !isNyState(state)) return skip(`skipped:outside_nyc:state=${state.toUpperCase().slice(0, 12)}`)
  const boroughRaw = (opp.borough ?? '').trim()
  if (boroughRaw && !isNycBorough(boroughRaw)) return skip(`skipped:outside_nyc:borough=${boroughRaw.slice(0, 20)}`)

  // 3. No / placeholder address.
  const address = (opp.address ?? '').trim()
  if (!address) return skip('skipped:no_address')
  if (PLACEHOLDER_ADDRESS.test(address) || isPlaceholderAddress(address)) return skip('skipped:placeholder_address')

  // 4. Strip any unit suffix (so it can't leak into the geocode query), then
  //    normalize. Requires a street number (a bare neighborhood/building name
  //    can't be resolved to a single parcel).
  const cleaned = stripBareUnitSuffix(address)
  const norm = normalizeAddress(cleaned)
  if (!norm || !norm.streetNumber) return skip('skipped:no_street_number')
  const key = norm.normalized
  const orgId = opp.organizationId

  // 5. Cache (building-level — unit is stripped by the normalizer).
  const cached = await readCache(key)
  if (cached) {
    return {
      propertyType:       cached.propertyType,
      propertyTypeReason: `cached:${cached.propertyTypeReason}`,
      confidence:         cached.confidence,
    }
  }

  // 6. Geocode → BBL. Borough cross-check only with an unambiguous borough.
  const crossCheckBorough = boroughForCrossCheck(boroughRaw)
  const boroughHint = crossCheckBorough ?? (isNycBorough(boroughRaw) ? boroughRaw : null)
  const street = norm.streetName ? `${norm.streetNumber} ${norm.streetName}` : address
  const geoQuery = `${street}, ${boroughHint ? titleCase(boroughHint) : 'New York'}, NY`
  const geo = await geocodeAddress(geoQuery, crossCheckBorough)
  if (geo.rejectReason === 'unreachable') return transient('geosearch_unreachable')
  if (geo.rejectReason || !geo.bbl) {
    return finish(key, orgId, geo, null, null, null, `geosearch_failed:${geo.rejectReason ?? 'no_bbl'}`, 'low')
  }

  // 7. Air-rights / ancillary lot (lot >= 9000 are air rights, condo headers, etc.).
  const parts = splitBbl(geo.bbl)
  if (parts && parts.lot >= 9000) {
    return finish(key, orgId, geo, null, null, null, `air_rights_lot:bbl=${geo.bbl}`, 'high')
  }

  // 8. PLUTO classification.
  const plutoLookup = await lookupPluto(geo.bbl)
  if (plutoLookup.unreachable) return transient(`pluto_unreachable:bbl=${geo.bbl}`)
  const pluto = plutoLookup.record
  if (!pluto) {
    return finish(key, orgId, geo, null, null, null, `pluto_no_record:bbl=${geo.bbl}`, 'low')
  }
  const cls = (pluto.bldgclass ?? '').trim().toUpperCase()
  const mapping = classifyBuildingClass(cls)

  // 8b. Condo billing-lot correction. GeoSearch resolves a bare BUILDING address
  // to the condo BILLING/header lot (DOF assigns these in the 7501–8999 range),
  // whose PLUTO class (e.g. RM "Condo Mixed Residential & Commercial") describes
  // the WHOLE building — not the residential condo unit actually being listed.
  // So a residential luxury condo tower with ground-floor retail comes back RM →
  // "mixed-use", which is the exact mislabeling this phase exists to fix. If the
  // billing lot is an R-class (condo) lot WITH residential units, the listed
  // property is a condo. Gated on cls.startsWith('R') so it can never touch a
  // co-op (D-class) or any non-condo. unit lots (1001–1999) keep their precise
  // class — only the building-level aggregate lot is corrected.
  // Gate on mapping.type ∈ {condo, mixed-use} so the correction ONLY flips
  // residential/mixed R-class billing lots — never an explicitly commercial
  // R-class (RB/RK/RW/R5/R7/R8/RA/RC → commercial), an ancillary one
  // (RG/RP/RS/RT → null), or a condop (R9 → co-op). cls.startsWith('R') keeps it
  // to condo lots only (S-class mixed-use buildings have normal tax lots).
  const lot = parts?.lot ?? null
  const unitsRes = toInt(pluto.unitsres) ?? 0
  if (
    lot != null && lot >= 7501 && lot < 9000 &&
    cls.startsWith('R') && (mapping.type === 'condo' || mapping.type === 'mixed-use') &&
    unitsRes > 0
  ) {
    const total = toInt(pluto.unitstotal)
    return finish(key, orgId, geo, pluto, 'condo', false, `pluto_class=${cls}+condo_billing_lot:resi=${unitsRes}/${total ?? '?'}`, 'high')
  }

  // 9. Unambiguous class → use the mapping directly.
  if (!mapping.needsAcrisCheck) {
    if (mapping.type === null) {
      const reason = cls ? `pluto_class=${cls}:${mapping.description}` : `pluto_no_bldgclass:bbl=${geo.bbl}`
      return finish(key, orgId, geo, pluto, null, false, reason, cls ? 'high' : 'low')
    }
    return finish(key, orgId, geo, pluto, mapping.type, false, `pluto_class=${cls}:${mapping.description}`, 'high')
  }

  // 10. Ambiguous walk-up/elevator. Co-op-corp ownername heuristic first (skips ACRIS).
  if (looksLikeCoopOwner(pluto.ownername)) {
    const owner = (pluto.ownername ?? '').slice(0, 40)
    return finish(key, orgId, geo, pluto, 'co-op', false, `pluto_class=${cls}+ownername_corp:${owner}`, 'medium')
  }

  // 11. ACRIS condo-declaration override.
  const hasDecl = await hasCondoDeclaration(geo.bbl)
  if (hasDecl === true) {
    return finish(key, orgId, geo, pluto, 'condo', true, `pluto_class=${cls}+acris_condo_decl`, 'high')
  }
  if (hasDecl === false) {
    return finish(key, orgId, geo, pluto, mapping.type, false, `pluto_class=${cls}+acris_no_condo_decl`, 'high')
  }
  // hasDecl === null → ACRIS unreachable; keep the PLUTO class at lower confidence.
  return finish(key, orgId, geo, pluto, mapping.type, null, `pluto_class=${cls}+acris_unreachable`, 'medium')
}

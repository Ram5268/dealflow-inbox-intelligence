import type { ContactRanking } from '../ranking/queueBuilder'

// Brief 45 (PR E): what the CRM's morning sync would copy for each ranked
// seller (its RO_SQL in the CRM's src/lib/core-data/dealflow-sync/sync.ts),
// computed from the call-list entries this route ranked instead of from a
// saved list. The CRM writes these fields onto the upload's new leads only.

// A copy of the CRM's BUYERS_SQL (Brief 38), kept word for word so both sides
// describe a seller's buyers the same way: the entry's primary and
// contributing matches (at most 5, best first), with each buyer's facts read
// as DealFlow's matcher reads them. It selects no phone number or email of any
// kind. It reads the entry from the alias `cqe`, as in the CRM.
export const BUYERS_SQL = `(
    SELECT COALESCE(jsonb_agg(to_jsonb(b) - 'ord' ORDER BY b."score" DESC, b.ord), '[]'::jsonb) FROM (
      SELECT x.ord, m."id" AS "matchId", m."score", m."tier", string_to_array(m."reason", ' + ') AS "reasonKeys",
        m."captureStatus", m."counterpartType" AS "type",
        COALESCE(eo."sourceAgentName", bc."fullName") AS "name", eo."sourceBrokerage" AS "brokerage",
        CASE WHEN cardinality(eo."neighborhoods") > 0 THEN eo."neighborhoods" ELSE array_remove(ARRAY[COALESCE(
          NULLIF(eo."neighborhood", ''), NULLIF(bc."neighborhood", ''), NULLIF(bc."initialNeighborhood", ''))], NULL) END AS "neighborhoods",
        COALESCE(eo."propertyTypes", '{}') AS "propertyTypes",
        COALESCE(eo."minBeds", eo."beds", bc."bedsMin") AS "bedsMin",
        COALESCE(eo."maxBeds", eo."beds", bc."bedsMax") AS "bedsMax",
        COALESCE(eo."minPrice", eo."price", bc."budgetMin") AS "priceMin",
        COALESCE(eo."maxPrice", eo."price", bc."budgetMax") AS "priceMax",
        COALESCE(eo."buyerArchetype", CASE WHEN bc."cashOnly" THEN 'CASH_BUYER' END) AS "buyerArchetype",
        COALESCE(eo."isTestData", bc."isTestData", false) AS "isTestData"
      FROM unnest(array_prepend(cqe."primaryMatchId", cqe."contributingMatchIds")) WITH ORDINALITY AS x(id, ord)
      JOIN "Match" m ON m."id" = x.id
      LEFT JOIN "ExtractedOpportunity" eo ON m."counterpartType" = 'opportunity' AND eo."id" = m."counterpartId"
      LEFT JOIN "MojoContact" bc ON m."counterpartType" = 'mojo' AND bc."id" = m."counterpartId"
      ORDER BY x.ord LIMIT 5
    ) b)`

// $1 = jsonb [{contactId, primaryMatchId, contributingMatchIds}], one per
// ranked seller. The primary match's own columns, as the CRM's RO_SQL reads
// them (LEFT JOIN "Match" on the primary match id), plus the buyers.
export const SIGNALS_SQL = `
SELECT cqe."contactId",
  m."score" AS primary_match_fit, m."captureStatus" AS primary_capture_status,
  m."matchFitConfidence" AS primary_match_confidence, m."reason" AS match_reason,
  ${BUYERS_SQL} AS buyers
FROM jsonb_to_recordset($1::jsonb) AS cqe("contactId" text, "primaryMatchId" text, "contributingMatchIds" text[])
LEFT JOIN "Match" m ON m."id" = cqe."primaryMatchId"`

export interface SignalRow {
  contactId: string
  primary_match_fit: number | null
  primary_capture_status: string | null
  primary_match_confidence: string | null
  match_reason: string | null
  buyers: unknown
}

// The CRM's DealflowBuyer (src/lib/core-data/dealflow-sync/buyers.ts).
export interface DealflowBuyer {
  matchId: string
  score: number | null
  tier: string | null
  reasonKeys: string[]
  captureStatus: string | null
  type: 'opportunity' | 'mojo'
  name: string | null
  brokerage: string | null
  neighborhoods: string[]
  propertyTypes: string[]
  bedsMin: number | null
  bedsMax: number | null
  priceMin: number | null
  priceMax: number | null
  buyerArchetype: string | null
  isTestData: boolean
}

export const MAX_BUYERS = 5
const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => str(x) !== null) : [])

// The CRM's toBuyers whitelist, applied before anything leaves DealFlow: only
// the fields above, at most 5, so nothing else (a contact detail, say) can
// ride along [engineering precaution, Brief 38].
export function toBuyers(raw: unknown): DealflowBuyer[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object' && str((b as { matchId?: unknown }).matchId) !== null)
    .slice(0, MAX_BUYERS)
    .map(b => ({
      matchId: b.matchId as string, score: num(b.score), tier: str(b.tier), reasonKeys: strs(b.reasonKeys),
      captureStatus: str(b.captureStatus), type: b.type === 'mojo' ? 'mojo' : 'opportunity',
      name: str(b.name), brokerage: str(b.brokerage), neighborhoods: strs(b.neighborhoods),
      propertyTypes: strs(b.propertyTypes), bedsMin: num(b.bedsMin), bedsMax: num(b.bedsMax),
      priceMin: num(b.priceMin), priceMax: num(b.priceMax), buyerArchetype: str(b.buyerArchetype),
      isTestData: b.isTestData === true,
    }))
}

// One scored lead in the response (CONTRACT §7). A seller the hard filters
// leave off the call list (no matches, a do-not-call status, …) comes back
// with nulls and the filter's reason, as the morning sync leaves such a lead
// unranked.
export interface ScoredLead {
  crmLeadId: string
  mojoId: string
  priorityScore: number | null
  queueReason: string | null
  primaryMatchId: string | null
  primaryMatchFit: number | null
  primaryCaptureStatus: string | null
  primaryMatchConfidence: string | null
  matchReason: string | null
  contributions: Record<string, number> | null
  buyers: DealflowBuyer[]
  notRankedReason: string | null
}

export function toScoredLead(crmLeadId: string, mojoId: string, ranking: ContactRanking, signal: SignalRow | undefined): ScoredLead {
  if (ranking.excluded) {
    return {
      crmLeadId, mojoId, priorityScore: null, queueReason: null, primaryMatchId: null, primaryMatchFit: null,
      primaryCaptureStatus: null, primaryMatchConfidence: null, matchReason: null, contributions: null, buyers: [],
      notRankedReason: ranking.reason,
    }
  }
  const e = ranking.entry
  return {
    crmLeadId, mojoId, priorityScore: e.priorityScore, queueReason: e.reason, primaryMatchId: e.primaryMatchId,
    primaryMatchFit: signal?.primary_match_fit ?? null, primaryCaptureStatus: signal?.primary_capture_status ?? null,
    primaryMatchConfidence: signal?.primary_match_confidence ?? null, matchReason: signal?.match_reason ?? null,
    contributions: e.contributions, buyers: toBuyers(signal?.buyers), notRankedReason: null,
  }
}

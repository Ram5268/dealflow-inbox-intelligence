import type { ImportBatchState } from './request'

// Brief 45 (PR E): the CRM reads behind POST /api/crm/score-import. They go
// through DealFlow's existing read-only CRM link (lib/crm-sync/roClient.ts
// crmQuery: one SELECT per call, inside a READ ONLY transaction); DealFlow
// never writes to the CRM. The CRM's own lead read is crmReader's
// readCrmLeads, unchanged, shared with the nightly sync.
export type CrmQuery = <T>(sql: string, params?: unknown[]) => Promise<T[]>

// $1 = ImportBatch id. The CRM stores UTC in `timestamp without time zone`
// columns (Prisma), so AT TIME ZONE 'UTC' hands them over as instants whatever
// the server's or this process's time zone (as the CRM's own RO_SQL does).
export const IMPORT_BATCH_SQL = `
SELECT o.slug AS "orgSlug", b.status, b."completedAt" AT TIME ZONE 'UTC' AS "completedAt",
       b."dealflowScoreTokenHash" AS "tokenHash", b."dealflowScoredAt" AT TIME ZONE 'UTC' AS "scoredAt"
FROM "ImportBatch" b JOIN "Organization" o ON o.id = b."organizationId"
WHERE b.id = $1`

// $1 = ImportBatch id, $2 = the requested lead ids. An upload's NEW leads
// (CONTRACT §7): stamped with its source AND created no earlier than the upload
// itself, in the same organization. A merge re-stamps `source` on someone who
// was already in the CRM, so `source` alone would count them too. Leads with
// no Mojo ID come back too (mojoId null), so they can be reported.
export const NEW_IMPORT_LEADS_SQL = `
SELECT l.id, l."mojoId"
FROM "ImportBatch" b
JOIN "Lead" l ON l."organizationId" = b."organizationId"
  AND l.source = 'import:' || b.id AND l."createdAt" >= b."createdAt"
WHERE b.id = $1 AND l.id = ANY($2::text[])`

export async function readImportBatch(query: CrmQuery, importId: string): Promise<ImportBatchState | null> {
  const [row] = await query<ImportBatchState>(IMPORT_BATCH_SQL, [importId])
  return row ?? null
}

export function readNewImportLeads(query: CrmQuery, importId: string, leadIds: string[]) {
  return query<{ id: string; mojoId: string | null }>(NEW_IMPORT_LEADS_SQL, [importId, leadIds])
}

import { crmQuery } from './roClient'

// Brief 34: one read of every CRM lead in the org, with its first contact's
// phones/emails (primary first) and its custom fields keyed by definition name.
// Timestamps come back as text and are copied as-is: both databases store
// `timestamp without time zone`.
export interface CrmFieldValue { t: string | null; n: number | null; d: string | null }

export interface CrmLeadRow {
  id: string
  mojoId: string
  name: string | null
  displayName: string
  primaryAddressFull: string | null
  updatedAt: string
  contactName: string | null
  phones: string[]
  emails: string[]
  fields: Record<string, CrmFieldValue>
}

const LEADS_SQL = `
WITH f AS (
  SELECT v."objectId",
         json_object_agg(d.name, json_build_object('t', v."valueText", 'n', v."valueNumber", 'd', v."valueDate"::text)) AS fields
  FROM "CustomFieldValue" v JOIN "CustomFieldDefinition" d ON d.id = v."definitionId"
  WHERE v."objectType" = 'lead' GROUP BY v."objectId"
), ph AS (
  SELECT "contactId", json_agg(phone ORDER BY "isPrimary" DESC, "createdAt", id) AS phones FROM "ContactPhone" GROUP BY 1
), em AS (
  SELECT "contactId", json_agg(email ORDER BY "isPrimary" DESC, id) AS emails
  FROM "ContactEmail" WHERE NOT "isUnsubscribed" GROUP BY 1
)
SELECT l.id, l."mojoId", l.name, l."displayName", l."primaryAddressFull", l."updatedAt"::text AS "updatedAt",
       c.name AS "contactName", COALESCE(ph.phones, '[]') AS phones, COALESCE(em.emails, '[]') AS emails,
       COALESCE(f.fields, '{}') AS fields
FROM "Lead" l
JOIN "Organization" o ON o.id = l."organizationId" AND o.slug = $1
LEFT JOIN LATERAL (SELECT id, name FROM "Contact" WHERE "leadId" = l.id ORDER BY "createdAt", id LIMIT 1) c ON true
LEFT JOIN f ON f."objectId" = l.id
LEFT JOIN ph ON ph."contactId" = c.id
LEFT JOIN em ON em."contactId" = c.id
WHERE l."mojoId" IS NOT NULL`

export function readCrmLeads(orgSlug: string): Promise<CrmLeadRow[]> {
  return crmQuery<CrmLeadRow>(LEADS_SQL, [orgSlug])
}

// Brief 43 PR 5 (D11 [Ryan, 2026-10-18]: opted-out sellers are marked "do not
// contact"): the CRM leads whose phone is on the CRM's own opt-out list,
// DncSuppression with source 'internal' (STOP replies and opt-outs recorded in
// the CRM). Federal and state registry hits ('federal', 'state:*') are a cache
// the CRM checks at dial time, not a person asking us to stop, so they're left
// out [engineering precaution]. Phones match on their last 10 digits, so the
// CRM's E.164 "+1…" and older 10- or 11-digit forms all agree.
export const OPT_OUTS_SQL = `
SELECT DISTINCT c."leadId" AS "leadId"
FROM "DncSuppression" s
JOIN "Organization" o ON o.id = s."organizationId" AND o.slug = $1
JOIN "Contact" c ON c."organizationId" = o.id
JOIN "ContactPhone" p ON p."contactId" = c.id
  AND right(regexp_replace(p.phone, '[^0-9]', '', 'g'), 10) = right(regexp_replace(s.phone, '[^0-9]', '', 'g'), 10)
WHERE s.source = 'internal' AND length(regexp_replace(s.phone, '[^0-9]', '', 'g')) >= 10`

// A separate read from LEADS_SQL, run alongside it (runSync.ts), so a problem
// here can't stop or hold up the lead sync: a missing table or grant, or no
// answer within OPT_OUT_READ_TIMEOUT_MS, logs and returns null, and the sync
// goes on without new opt-out marks. Marks already written stay (markOptOut
// only ever adds) [engineering precaution: the sync runs in production every
// morning].
export const OPT_OUT_READ_TIMEOUT_MS = 10_000

export async function readCrmOptOutLeadIds(
  orgSlug: string,
  query: <T>(sql: string, params: unknown[]) => Promise<T[]> = crmQuery,
  timeoutMs: number = OPT_OUT_READ_TIMEOUT_MS,
): Promise<Set<string> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
    // Never the reason a finished sync's process stays open.
    ;(timer as { unref?: () => void }).unref?.()
  })
  try {
    const rows = await Promise.race([query<{ leadId: string }>(OPT_OUTS_SQL, [orgSlug]), timedOut])
    if (rows === 'timeout') {
      console.warn(`[crm-sync] opt-out list not read within ${timeoutMs} ms; no new do-not-contact marks this run`)
      return null
    }
    return new Set(rows.map(r => r.leadId))
  } catch (e) {
    console.warn('[crm-sync] opt-out list not read; no new do-not-contact marks this run:', e instanceof Error ? e.message : e)
    return null
  } finally {
    clearTimeout(timer)
  }
}

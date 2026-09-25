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

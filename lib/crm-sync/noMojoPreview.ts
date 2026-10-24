import { STAND_IN_PREFIX } from './crmReader'
import { phoneKey } from './mapLead'
import { personKey, type ExistingRow, type SyncPlan } from './plan'

// Brief 48 (PR 8, item 4.1): the pure parts of scripts/brief48-no-mojo-preview.ts, which
// counts the CRM leads with no Mojo ID and what the next copy would do with them. Counts
// only: no name, number, address or id.

// $1 = the organization's slug. The CRM's leads by Mojo ID (read only, through
// DealFlow's read-only CRM link). A real Mojo ID that starts like a stand-in key
// would be mistaken for one, so it is counted (it should be 0).
export const CRM_MOJO_COUNTS_SQL = `
SELECT count(*)::int AS leads,
  count(*) FILTER (WHERE l."mojoId" IS NULL)::int AS "noMojoId",
  count(*) FILTER (WHERE l."mojoId" = '')::int AS "emptyMojoId",
  count(*) FILTER (WHERE starts_with(l."mojoId", '${STAND_IN_PREFIX}'))::int AS "mojoIdLikeStandIn"
FROM "Lead" l JOIN "Organization" o ON o.id = l."organizationId" AND o.slug = $1`

// $1 = organizationId. DealFlow rows already under a stand-in key (0 before PR 8's first copy).
export const DF_STAND_IN_COUNT_SQL = `
SELECT count(*)::int AS n FROM "MojoContact" WHERE "organizationId" = $1 AND starts_with("mojoId", '${STAND_IN_PREFIX}')`

export interface CrmMojoCounts { leads: number; noMojoId: number; emptyMojoId: number; mojoIdLikeStandIn: number }

// $1 = organizationId. Each real row's metadata.source and CRM lead id (ids only), to
// tell which planned duplicates are new marks and whose they are.
export const DF_ROW_SOURCES_SQL = `
SELECT id, metadata->>'source' AS source, metadata->>'crmLeadId' AS "crmLeadId"
FROM "MojoContact" WHERE "organizationId" = $1 AND NOT "isTestData"`

export interface RowSource { source: string | null; crmLeadId: string | null }

// What the next copy's plan does, by kind. `taken`: Mojo IDs held by rows the copy never
// writes (test data, another organization), whose leads are neither inserted nor updated.
// Brief 48 (PR 8 review r1): `existing` = EXISTING_SQL's rows. A new seller "like" a
// seller DealFlow already copies from the CRM (source 'crm') shares one of its phone
// numbers (10 digits), or its name and street: most likely the same person entered
// in the CRM twice, who would then be matched and on the call list twice. "No area":
// a new seller without a ZIP or neighborhood, which the matcher pairs with buyers
// anywhere. Counts only.
export function noMojoPlanCounts(
  plan: SyncPlan, taken: ReadonlySet<string>, rows: ReadonlyMap<string, RowSource>, existing: readonly ExistingRow[] = [],
) {
  const standIn = (k: string) => k.startsWith(STAND_IN_PREFIX)
  const inserts = plan.upserts.filter(u => !u.keeper && !taken.has(u.contact.mojoId))
  const blocked = plan.rekeys.filter(r => taken.has(r.new_id))
  const csvRekeys = plan.rekeys.filter(r => r.old_id.startsWith('csv_') && !taken.has(r.new_id))
  const newMarks = plan.duplicates.filter(d => rows.get(d.id)?.source !== 'duplicate')
  const live = existing.filter(r => rows.get(r.id)?.source === 'crm')
  const livePhones = new Set(live.flatMap(r => [r.phone, ...(r.additionalPhones ?? [])]).flatMap(p => (p ? [phoneKey(p)] : [])).filter(Boolean))
  const liveNames = new Set(live.filter(r => r.fullName && r.address).map(r => personKey(r.fullName, r.address)))
  const samePhone = (u: SyncPlan['upserts'][number]) => u.contact.phones.some(p => livePhones.has(phoneKey(p)))
  const sameName = (u: SyncPlan['upserts'][number]) => !!u.contact.address && liveNames.has(personKey(u.contact.fullName, u.contact.address))
  return {
    newSellersWithoutMojoId: inserts.filter(u => standIn(u.contact.mojoId)).length,
    newSellersWithMojoId: inserts.filter(u => !standIn(u.contact.mojoId)).length,
    newSellersNoArea: inserts.filter(u => !u.contact.zipCode && !u.contact.neighborhood).length,
    newSellersLikeExisting: { samePhone: inserts.filter(samePhone).length, sameNameAndStreet: inserts.filter(sameName).length },
    sellersOnTheirOwnRow: plan.upserts.filter(u => u.keeper && u.keeper.mojoId === u.contact.mojoId).length,
    reKeyedByCrmLeadId: plan.rekeys.length - csvRekeys.length - blocked.length, // the same row, its key changed (stand-in <-> Mojo ID)
    reKeyedCsv: csvRekeys.length,
    // A re-key REKEY_SQL leaves undone: the new Mojo ID is held by test data or another
    // organization. That seller is then neither updated nor kept (marked crm_removed).
    reKeysBlocked: blocked.length,
    // Rows newly marked as a duplicate of their seller's row: a lead's own older rows
    // (found by its CRM lead id), and csv copies.
    newDuplicateMarks: {
      ownOlderRows: newMarks.filter(d => rows.get(d.id)?.crmLeadId).length,
      csvCopies: newMarks.filter(d => !rows.get(d.id)?.crmLeadId).length,
    },
    heldElsewhere: plan.upserts.filter(u => !u.keeper && taken.has(u.contact.mojoId)).length,
    skipped: plan.skipped.length,
  }
}

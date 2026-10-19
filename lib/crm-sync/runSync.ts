import { prisma } from '../prisma'
import { readCrmLeads, readCrmOptOutLeadIds } from './crmReader'
import { mapLead, markOptOut } from './mapLead'
import { planSync, type ExistingRow, type SyncPlan } from './plan'
import {
  DUPLICATES_SQL, LEGACY_SQL, REKEY_SQL, REMOVED_SQL, UPSERT_SQL, diffUpdates, toUpsertRow, type UpsertReturn,
} from './upsert'

// Brief 34: CRM → DealFlow lead sync. Used by nightly-pipeline step 1 and by
// scripts/crm-lead-sync.ts. The CRM read is read-only. Every DealFlow write
// happens in one transaction, and a dry run executes the same statements then
// rolls back.
export const ORG_SLUG = 'dealflow-ryan'
const CHUNK = 500

export type CrmSyncResult = {
  dryRun: boolean
  crmLeads: number
  inserted: number
  updated: number
  rekeyed: number
  duplicatesMarked: number
  legacyMarked: number
  removedMarked: number
  neighborhoodsResolved: number
  optOutLeads: number | null // Brief 43 PR 5: CRM leads on the CRM's opt-out list; null = not read this run
  filled: Record<string, number>
  skipped: SyncPlan['skipped']
  ms: number
}

class DryRunRollback extends Error {
  constructor(readonly result: CrmSyncResult) { super('dry run: rolled back') }
}

// Exported for the import-scoring route (Brief 45, PR E), which plans its lead
// copy with the same reads.
export const EXISTING_SQL = `
SELECT id, "mojoId", "fullName", address, state, "zipCode", phone, "additionalPhones", email, "additionalEmails"
FROM "MojoContact" WHERE "organizationId" = $1 AND NOT "isTestData"`

// $1 = organizationId. Rows the sync has marked as CRM leads (the removal guard).
export const MARKED_CRM_SQL =
  `SELECT count(*)::int AS n FROM "MojoContact" WHERE "organizationId" = $1 AND metadata->>'source' = 'crm'`

export async function runCrmLeadSync({ dryRun = false } = {}): Promise<CrmSyncResult> {
  const started = Date.now()
  const org = await prisma.organization.findUniqueOrThrow({ where: { slug: ORG_SLUG }, select: { id: true } })
  // Brief 43 PR 5: the CRM's own opt-out list, read on its own so a failure only
  // skips new do-not-contact marks (crmReader.ts readCrmOptOutLeadIds).
  const optOuts = await readCrmOptOutLeadIds(ORG_SLUG)
  const contacts = (await readCrmLeads(ORG_SLUG)).map(mapLead).map(c => markOptOut(c, optOuts))

  // Removal guard: an empty or shrunken CRM read must never mark everyone removed.
  const [{ n: markedCrm }] = await prisma.$queryRawUnsafe<{ n: number }[]>(MARKED_CRM_SQL, org.id)
  if (contacts.length === 0 || contacts.length < 0.9 * markedCrm) {
    throw new Error(`CRM returned ${contacts.length} leads but ${markedCrm} rows are marked crm; aborting before any write`)
  }

  const plan = planSync(contacts, await prisma.$queryRawUnsafe<ExistingRow[]>(EXISTING_SQL, org.id))
  const rows = plan.upserts.map(toUpsertRow)
  try {
    return await prisma.$transaction(async tx => {
      const rekeyed = await tx.$executeRawUnsafe(REKEY_SQL, JSON.stringify(plan.rekeys))
      const returned: UpsertReturn[] = []
      for (let i = 0; i < rows.length; i += CHUNK) {
        returned.push(...await tx.$queryRawUnsafe<UpsertReturn[]>(UPSERT_SQL, JSON.stringify(rows.slice(i, i + CHUNK)), org.id))
      }
      const { filled, changed } = diffUpdates(returned)
      if (changed.length > 0) {
        throw new Error(`keep-old rule violated on ${changed.length} values (rolled back): ${changed.slice(0, 10).join(', ')}`)
      }
      const insertedIds = new Set(returned.filter(r => r.inserted).map(r => r.mojoId))
      const result: CrmSyncResult = {
        dryRun,
        crmLeads: contacts.length,
        inserted: insertedIds.size,
        updated: returned.length - insertedIds.size,
        rekeyed,
        duplicatesMarked: await tx.$executeRawUnsafe(DUPLICATES_SQL, JSON.stringify(plan.duplicates)),
        legacyMarked: await tx.$executeRawUnsafe(LEGACY_SQL, org.id),
        removedMarked: await tx.$executeRawUnsafe(REMOVED_SQL, org.id, JSON.stringify(contacts.map(c => c.mojoId))),
        neighborhoodsResolved: rows.filter(r => insertedIds.has(r.mojoId) && r.neighborhood).length,
        optOutLeads: optOuts ? contacts.filter(c => c.metadata.crmOptOut).length : null,
        filled,
        skipped: plan.skipped,
        ms: Date.now() - started,
      }
      if (dryRun) throw new DryRunRollback(result)
      await tx.auditLog.create({ data: { organizationId: org.id, action: 'CRM_LEAD_SYNC', detailsJson: result } })
      return result
    }, { maxWait: 10_000, timeout: 120_000 })
  } catch (e) {
    if (e instanceof DryRunRollback) return e.result
    throw e
  }
}

import { prisma } from '../prisma'
import { readCrmLeads, readCrmOptOutLeadIds } from './crmReader'
import { mapLead, markOptOut } from './mapLead'
import { planSync, type ExistingRow, type SyncPlan } from './plan'
import {
  DUPLICATES_SQL, LEGACY_SQL, REKEY_SQL, REMOVED_SQL, UPSERT_SQL, diffUpdates, toUpsertRow, type UpsertReturn,
} from './upsert'
import {
  CRM_WINS_INSERT_SQL, CRM_WINS_RAN_LAST_SQL, CRM_WINS_UPDATE_SQL, STATUS_SQL, crmOwnName, crmWinsKeepStatus, crmWinsRunCounts,
  identityLosses, massChangeLimit, overMassChangeLimit, readCrmWinsSwitch, toCrmWinsRow,
} from './crmWins'

// Brief 34: CRM → DealFlow lead sync. Used by nightly-pipeline step 1 and by
// scripts/crm-lead-sync.ts. The CRM read is read-only. Every DealFlow write
// happens in one transaction, and a dry run executes the same statements then
// rolls back.
// Brief 48 (PR 7): with the CRM_WINS switch on (crmWins.ts), existing sellers
// take the CRM's values, and the audit row counts the changes per field instead
// of the keep-old self-check rolling back on any change. With it off, the copy
// is exactly as before.
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
  // Brief 48 (PR 7): only on a run with the CRM_WINS switch on (counts only).
  crmWins?: true
  changed?: Record<string, number> // existing values replaced, per field
  notesKeptBelow?: number // sellers whose own DealFlow notes moved under the CRM's this run
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
  // Brief 43 PR 5: the CRM's own opt-out list, read alongside the leads; a
  // failure or a slow answer only skips new do-not-contact marks
  // (crmReader.ts readCrmOptOutLeadIds never throws).
  const [leads, optOuts] = await Promise.all([readCrmLeads(ORG_SLUG), readCrmOptOutLeadIds(ORG_SLUG)])
  const contacts = leads.map(mapLead).map(c => markOptOut(c, optOuts))

  // Removal guard: an empty or shrunken CRM read must never mark everyone removed.
  const [{ n: markedCrm }] = await prisma.$queryRawUnsafe<{ n: number }[]>(MARKED_CRM_SQL, org.id)
  if (contacts.length === 0 || contacts.length < 0.9 * markedCrm) {
    throw new Error(`CRM returned ${contacts.length} leads but ${markedCrm} rows are marked crm; aborting before any write`)
  }

  const plan = planSync(contacts, await prisma.$queryRawUnsafe<ExistingRow[]>(EXISTING_SQL, org.id))
  // Brief 48 (PR 7): read once per copy; a failed read is off.
  const crmWins = await readCrmWinsSwitch(prisma)
  const ownNames = new Map(leads.map(l => [l.mojoId, crmOwnName(l)]))
  // Brief 48 (PR 7 review r1): DealFlow's statuses, for the opt-out wording rule (crmWins.ts).
  const statuses = crmWins
    ? new Map((await prisma.$queryRawUnsafe<{ id: string; status: string }[]>(STATUS_SQL, org.id)).map(r => [r.id, r.status]))
    : null
  const rows = statuses
    ? plan.upserts.map(u => toCrmWinsRow(u, ownNames.get(u.contact.mojoId) ?? null,
      !!u.keeper && crmWinsKeepStatus(statuses.get(u.keeper.id) ?? null, u.contact.status)))
    : plan.upserts.map(toUpsertRow)
  try {
    return await prisma.$transaction(async tx => {
      const rekeyed = await tx.$executeRawUnsafe(REKEY_SQL, JSON.stringify(plan.rekeys))
      const returned: UpsertReturn[] = []
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = JSON.stringify(rows.slice(i, i + CHUNK))
        if (!crmWins) returned.push(...await tx.$queryRawUnsafe<UpsertReturn[]>(UPSERT_SQL, chunk, org.id))
        else {
          returned.push(...await tx.$queryRawUnsafe<UpsertReturn[]>(CRM_WINS_UPDATE_SQL, chunk, org.id))
          returned.push(...await tx.$queryRawUnsafe<UpsertReturn[]>(CRM_WINS_INSERT_SQL, chunk, org.id))
        }
      }
      // Keep-old: any changed existing value means the rule broke, so roll back.
      // CRM wins [Ryan, 2026-10-19]: changes are the point and are counted per
      // field; a value that went blank breaks its rule, so roll back.
      const wins = crmWins ? crmWinsRunCounts(returned) : null
      const keepOld = wins ? null : diffUpdates(returned)
      if (keepOld && keepOld.changed.length > 0) {
        const { changed } = keepOld
        throw new Error(`keep-old rule violated on ${changed.length} values (rolled back): ${changed.slice(0, 10).join(', ')}`)
      }
      if (wins && wins.erased.length > 0) {
        throw new Error(`CRM-wins rule violated: ${wins.erased.length} values went blank (rolled back)`)
      }
      // Brief 48 (PR 7 review r1) [engineering precaution]: the mass-change limit (crmWins.ts).
      if (wins) {
        const limit = massChangeLimit(plan.upserts.filter(u => u.keeper).length)
        const over = overMassChangeLimit(identityLosses(returned.filter(r => !r.inserted)), limit)
        if (over.length > 0) {
          const [{ ranLast }] = await tx.$queryRawUnsafe<{ ranLast: boolean }[]>(CRM_WINS_RAN_LAST_SQL, org.id)
          if (ranLast) throw new Error(`CRM-wins mass change (rolled back): ${over.join(', ')} sellers, over the limit of ${limit}`)
        }
      }
      const { filled } = wins ?? keepOld!
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
        ...(wins && { crmWins: true as const, changed: wins.changed, notesKeptBelow: wins.notesKeptBelow }),
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

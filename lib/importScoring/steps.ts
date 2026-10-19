import { randomUUID } from 'crypto'
import type { PrismaClient } from '@prisma/client'
import type { CrmLeadRow } from '../crm-sync/crmReader'
import { mapLead } from '../crm-sync/mapLead'
import { planSync, type ExistingRow, type SyncPlan } from '../crm-sync/plan'
import { EXISTING_SQL, MARKED_CRM_SQL } from '../crm-sync/runSync'
import { DUPLICATES_SQL, REKEY_SQL, UPSERT_SQL, diffUpdates, toUpsertRow, type UpsertReturn } from '../crm-sync/upsert'
import { MAX_KEPT_PER_SELLER, loadScoringInputs, scoreAll } from '../matching/nightly/runScoring'
import { pickTonight, type SwitchCheck } from '../matching/ourEstimates'
import { toMatchRow } from '../matching/nightly/select'
import { DELETE_STALE_MATCHES_OF_SELLERS_SQL, UPSERT_MATCHES_SQL } from '../matching/nightly/sql'
import {
  QUEUE_CONTACT_SELECT, contactScopeWhere, loadMatchBuckets, queueMatchWhere, rankContact, type ContactRanking,
} from '../ranking/queueBuilder'

// Brief 45 (PR E): the nightly pipeline's three steps, for one upload's new
// leads only, built from the nightly's own pieces (so a change to them, e.g.
// Brief 44's matching features, reaches both):
//   1 the CRM lead copy    (lib/crm-sync: mapLead, planSync, UPSERT_SQL, keep-old guard)
//   2 scoring              (lib/matching/nightly: loadScoringInputs, scoreAll, Match upsert)
//   3 call priority        (lib/ranking/queueBuilder: rankContact), computed, never saved
// Steps 1 and 2 write in one transaction each, as the nightly steps do.
const LEAD_CHUNK = 500 // as runSync
const MATCH_CHUNK = 1_000 // as runScoring
const TX = { maxWait: 10_000, timeout: 120_000 } // as the nightly steps

// ── Step 1: the CRM lead copy ───────────────────────────────────────────────

// The part of a whole-CRM plan that concerns these Mojo IDs. planSync must see
// every CRM lead (whether a name and street are ambiguous depends on all of
// them), so its decisions match the nightly's; only applying is narrowed.
// A keeper row belongs to exactly one lead, so its duplicates go with it.
export function restrictPlan(plan: SyncPlan, mojoIds: Set<string>): SyncPlan {
  const upserts = plan.upserts.filter(u => mojoIds.has(u.contact.mojoId))
  const keepers = new Set(upserts.flatMap(u => (u.keeper ? [u.keeper.id] : [])))
  return {
    upserts,
    rekeys: plan.rekeys.filter(r => mojoIds.has(r.new_id)),
    duplicates: plan.duplicates.filter(d => keepers.has(d.keeper_id)),
    skipped: plan.skipped.filter(s => mojoIds.has(s.mojoId)),
  }
}

export interface LeadCopyResult {
  copied: Map<string, string> // CRM lead id → Mojo ID, for each lead the copy covered
  inserted: number
  updated: number
  rekeyed: number
  duplicatesMarked: number
  filled: Record<string, number>
}

// Keep-old / fill-blanks [Ryan, Brief 34]: UPSERT_SQL only fills blanks and
// appends new phones and emails; diffUpdates double-checks every returned row
// and rolls the whole copy back if any existing value changed. The nightly's
// REMOVED_SQL and LEGACY_SQL never run here: they judge the whole organization.
export async function copyImportLeads(
  db: PrismaClient, orgId: string, crmRows: CrmLeadRow[], leadIds: Set<string>,
): Promise<LeadCopyResult> {
  const contacts = crmRows.map(mapLead)
  // The nightly's guard [engineering precaution, Brief 34]: an empty or shrunken
  // CRM read means the link is broken, so nothing is planned from it.
  const [{ n: markedCrm }] = await db.$queryRawUnsafe<{ n: number }[]>(MARKED_CRM_SQL, orgId)
  if (contacts.length === 0 || contacts.length < 0.9 * markedCrm) {
    throw new Error(`CRM returned ${contacts.length} leads but ${markedCrm} rows are marked crm; aborting before any write`)
  }
  const plan = planSync(contacts, await db.$queryRawUnsafe<ExistingRow[]>(EXISTING_SQL, orgId))
  const crmLeadIdOf = new Map(crmRows.filter(r => leadIds.has(r.id)).map(r => [r.mojoId, r.id]))
  const own = restrictPlan(plan, new Set(crmLeadIdOf.keys()))
  const rows = own.upserts.map(toUpsertRow)
  const copied = new Map(own.upserts.map(u => [crmLeadIdOf.get(u.contact.mojoId)!, u.contact.mojoId]))
  if (rows.length === 0) return { copied, inserted: 0, updated: 0, rekeyed: 0, duplicatesMarked: 0, filled: {} }

  return db.$transaction(async tx => {
    const rekeyed = await tx.$executeRawUnsafe(REKEY_SQL, JSON.stringify(own.rekeys))
    const returned: UpsertReturn[] = []
    for (let i = 0; i < rows.length; i += LEAD_CHUNK) {
      returned.push(...await tx.$queryRawUnsafe<UpsertReturn[]>(UPSERT_SQL, JSON.stringify(rows.slice(i, i + LEAD_CHUNK)), orgId))
    }
    const { filled, changed } = diffUpdates(returned)
    if (changed.length > 0) throw new Error(`keep-old rule violated on ${changed.length} values (rolled back)`)
    const inserted = returned.filter(r => r.inserted).length
    const duplicatesMarked = await tx.$executeRawUnsafe(DUPLICATES_SQL, JSON.stringify(own.duplicates))
    return { copied, inserted, updated: returned.length - inserted, rekeyed, duplicatesMarked, filled }
  }, TX)
}

// ── Step 2: scoring ─────────────────────────────────────────────────────────

export interface ImportScoringResult {
  sellers: Map<string, string> // Mojo ID → MojoContact id, for each seller scored
  stats: {
    sellers: number
    buyers: number
    demandExcludedNoLocation: number
    pairs: number
    eligible: number
    ineligibleByReason: Record<string, number>
    dismissed: number
    kept: number
    inserted: number
    updated: number
    deleted: number
    ourEstimates?: SwitchCheck // only with the USE_OUR_ESTIMATES switch on (Brief 44 PR 4)
  }
}

// The nightly's inputs, whole: every CRM seller and all buyer demand, the same
// SCORING_INCLUDE_TEST_BUYERS rule, and comps and substitution counts over all
// sellers. Only these sellers are scored. Their stale Match rows are deleted;
// never anyone else's (DELETE_STALE_MATCHES_OF_SELLERS_SQL).
export async function scoreImportSellers(db: PrismaClient, orgId: string, mojoIds: Set<string>): Promise<ImportScoringResult> {
  const { sellers, listings, buyers, ctx, dismissed, demandExcludedNoLocation, ourEstimates } = await loadScoringInputs(orgId, db)
  const idx = sellers.flatMap((s, i) => (mojoIds.has(s.mojoId) ? [i] : []))
  const mine = idx.map(i => sellers[i])
  const myListings = idx.map(i => listings[i])
  // Brief 44 (PR 4): with the USE_OUR_ESTIMATES switch on, the nightly scores both ways
  // and keeps the results with our values only if they pass its rollback checks
  // (pickTonight). These sellers get the same treatment, checked on them alone. Turning
  // the switch off after a failed check stays the nightly's job (recordRollback): an
  // import never changes it [engineering precaution].
  const night = ourEstimates
    ? pickTonight(
      { ...ourEstimates, applied: myListings.filter(l => l.ourEstimate === true).length },
      () => scoreAll(myListings, buyers, ctx, dismissed),
      () => scoreAll(idx.map(i => ourEstimates.without.listings[i]), buyers, ourEstimates.without.ctx, dismissed),
    )
    : { result: scoreAll(myListings, buyers, ctx, dismissed), check: undefined }
  const { kept, ...stats } = night.result
  if (kept.length > MAX_KEPT_PER_SELLER * mine.length) {
    throw new Error(`scoring kept ${kept.length} pairs for ${mine.length} sellers; aborting before any write`)
  }

  const rows = kept.map(c => ({ id: randomUUID(), ...toMatchRow(c) }))
  const keys = rows.map(r => ({ opportunityId: r.opportunityId, counterpartId: r.counterpartId, counterpartType: r.counterpartType }))
  const written = mine.length === 0 ? { inserted: 0, updated: 0, deleted: 0 } : await db.$transaction(async tx => {
    let inserted = 0
    let updated = 0
    for (let i = 0; i < rows.length; i += MATCH_CHUNK) {
      const ret = await tx.$queryRawUnsafe<{ inserted: boolean }[]>(UPSERT_MATCHES_SQL, JSON.stringify(rows.slice(i, i + MATCH_CHUNK)), orgId)
      inserted += ret.filter(r => r.inserted).length
      updated += ret.filter(r => !r.inserted).length
    }
    const deleted = await tx.$executeRawUnsafe(DELETE_STALE_MATCHES_OF_SELLERS_SQL, orgId, JSON.stringify(keys), JSON.stringify(mine.map(s => s.id)))
    return { inserted, updated, deleted }
  }, TX)
  return {
    sellers: new Map(mine.map(s => [s.mojoId, s.id])),
    stats: {
      sellers: mine.length, buyers: buyers.length, demandExcludedNoLocation, ...stats, kept: rows.length, ...written,
      ...(night.check && { ourEstimates: night.check }),
    },
  }
}

// ── Step 3: call priority ───────────────────────────────────────────────────

// Each seller's place on the call list, computed exactly as the nightly list
// computes it (rankContact over the seller's own matches), and returned, never
// saved: the CRM's morning sync treats DealFlow's newest saved list as complete
// and clears the rank of everyone missing from it, so a partial list would wipe
// every other lead's ranking [Brief 45 §5.8].
export async function rankImportSellers(
  db: PrismaClient, orgId: string, sellerIds: string[], now: Date,
): Promise<Map<string, ContactRanking>> {
  if (sellerIds.length === 0) return new Map()
  const contacts = await db.mojoContact.findMany({
    where: { ...contactScopeWhere(orgId, 'crm'), id: { in: sellerIds } }, select: QUEUE_CONTACT_SELECT,
  })
  const buckets = await loadMatchBuckets(db, queueMatchWhere(orgId, sellerIds))
  const ctx = { now }
  return new Map(contacts.map(c => [c.id, rankContact(c, buckets.get(c.id) ?? [], ctx)]))
}

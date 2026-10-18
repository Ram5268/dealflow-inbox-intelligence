import type { PrismaClient } from '@prisma/client'
import { prisma } from '../prisma'
import { crmQuery } from '../crm-sync/roClient'
import { readCrmLeads, type CrmLeadRow } from '../crm-sync/crmReader'
import { ORG_SLUG } from '../crm-sync/runSync'
import { checkImportBatch, parseScoreImportBody } from './request'
import { readImportBatch, readNewImportLeads, type CrmQuery } from './crmRead'
import { copyImportLeads, rankImportSellers, scoreImportSellers } from './steps'
import { SIGNALS_SQL, toScoredLead, type ScoredLead, type SignalRow } from './signals'

// Brief 45 (PR E): score one CRM upload's new leads on request, so a new list
// is ranked within minutes instead of the next morning [Ryan, 2026-10-18: "no
// list ever sits unranked"]. Called by the CRM (POST /api/crm/score-import)
// in chunks of at most 500 leads. Nothing here contacts anyone: it copies the
// leads, scores them against buyer demand and returns their call-priority
// fields; the CRM writes those onto the same leads.
//
// Refusals (400/403/404) do no work and write nothing. Everything else:
//   1 which requested leads are this upload's new leads (CRM, read only)
//   2 the lead copy, scoring and call priority (lib/importScoring/steps.ts)
//   3 one AuditLog row, CRM_IMPORT_SCORING, with counts only
export interface ScoreImportDeps {
  crmQuery: CrmQuery
  readCrmLeads: (orgSlug: string) => Promise<CrmLeadRow[]>
  db: PrismaClient
  now: () => Date
}

export type SkipReason =
  | 'not_new_in_import' // not a lead this upload created (or not in the CRM at all)
  | 'no_mojo_id' // DealFlow's lead copy keys on the Mojo ID (CONTRACT §7: until Ryan decides on a stand-in key)
  | 'not_copied' // the lead copy left it out, as the nightly does (its name and street match more than one record)

export interface ScoreImportResponse { status: number; body: Record<string, unknown> }

const defaultDeps = (): ScoreImportDeps => ({ crmQuery, readCrmLeads, db: prisma, now: () => new Date() })

export async function scoreImport(raw: unknown, overrides: Partial<ScoreImportDeps> = {}): Promise<ScoreImportResponse> {
  const started = Date.now()
  const req = parseScoreImportBody(raw)
  if (!req) return { status: 400, body: { error: 'invalid_request' } }
  const deps: ScoreImportDeps = { ...defaultDeps(), ...overrides }
  try {
    const refusal = checkImportBatch(await readImportBatch(deps.crmQuery, req.importId), req.token, deps.now())
    if (refusal) return { status: refusal.status, body: { error: refusal.error } }
    return { status: 200, body: await scoreNewLeads(req.importId, req.leadIds, deps, started) }
  } catch (e) {
    // No details leave DealFlow; the CRM shows "scoring…" until the morning sync.
    console.error('[score-import] failed:', (e as Error).message)
    return { status: 500, body: { error: 'scoring_failed' } }
  }
}

const tally = (values: string[]) => values.reduce<Record<string, number>>((acc, v) => { acc[v] = (acc[v] ?? 0) + 1; return acc }, {})

async function scoreNewLeads(importId: string, leadIds: string[], deps: ScoreImportDeps, started: number) {
  const { db } = deps
  const newLeads = new Map((await readNewImportLeads(deps.crmQuery, importId, leadIds)).map(l => [l.id, l.mojoId]))
  const skipped = new Map<string, SkipReason>()
  const candidates = new Set<string>()
  for (const id of leadIds) {
    if (!newLeads.has(id)) skipped.set(id, 'not_new_in_import')
    else if (!newLeads.get(id)) skipped.set(id, 'no_mojo_id')
    else candidates.add(id)
  }

  const org = await db.organization.findUniqueOrThrow({ where: { slug: ORG_SLUG }, select: { id: true } })
  const copy = candidates.size > 0 ? await copyImportLeads(db, org.id, await deps.readCrmLeads(ORG_SLUG), candidates) : null
  const scoring = copy ? await scoreImportSellers(db, org.id, new Set(copy.copied.values())) : null
  const now = deps.now()
  const rankings = await rankImportSellers(db, org.id, [...(scoring?.sellers.values() ?? [])], now)
  const entries = [...rankings].flatMap(([contactId, r]) =>
    r.excluded ? [] : [{ contactId, primaryMatchId: r.entry.primaryMatchId, contributingMatchIds: r.entry.contributingMatchIds }])
  const signals = entries.length === 0 ? [] : await db.$queryRawUnsafe<SignalRow[]>(SIGNALS_SQL, JSON.stringify(entries))
  const signalOf = new Map(signals.map(s => [s.contactId, s]))

  const scored: ScoredLead[] = []
  for (const id of leadIds) {
    if (skipped.has(id)) continue
    const mojoId = copy?.copied.get(id)
    const contactId = mojoId ? scoring?.sellers.get(mojoId) : undefined
    const ranking = contactId ? rankings.get(contactId) : undefined
    if (!mojoId || !contactId || !ranking) { skipped.set(id, 'not_copied'); continue }
    scored.push(toScoredLead(id, mojoId, ranking, signalOf.get(contactId)))
  }

  const includeTestBuyers = process.env.SCORING_INCLUDE_TEST_BUYERS === 'true'
  const skips = (reason: SkipReason) => [...skipped.values()].filter(r => r === reason).length
  await db.auditLog.create({
    data: {
      organizationId: org.id,
      action: 'CRM_IMPORT_SCORING',
      // Counts only: no ids, names or values [engineering precaution].
      detailsJson: {
        requested: leadIds.length,
        newWithMojoId: candidates.size,
        skipped: { notNewInImport: skips('not_new_in_import'), noMojoId: skips('no_mojo_id'), notCopied: skips('not_copied') },
        scored: scored.length,
        ranked: scored.filter(s => s.notRankedReason === null).length,
        notRanked: tally(scored.flatMap(s => (s.notRankedReason ? [s.notRankedReason] : []))),
        ...(copy && { leadCopy: { inserted: copy.inserted, updated: copy.updated, rekeyed: copy.rekeyed, duplicatesMarked: copy.duplicatesMarked, filled: copy.filled } }),
        ...(scoring && { scoring: scoring.stats }),
        includeTestBuyers,
        ms: Date.now() - started,
      },
    },
  })

  return {
    importId,
    generatedAt: now.toISOString(),
    includeTestBuyers,
    ms: Date.now() - started,
    scored,
    skipped: leadIds.filter(id => skipped.has(id)).map(id => ({ crmLeadId: id, reason: skipped.get(id)! })),
  }
}

import { randomUUID } from 'crypto'
import type { MojoContact, PrismaClient } from '@prisma/client'
import { prisma } from '../../prisma'
import { mojoContactToBuyerData, mojoContactToListingData, opportunityToBuyerData } from '../adapters'
import { precomputeCompsMedians, precomputeSubstitutionCounts } from '../compsCache'
import { resolveDismissKey } from '../dismissKey'
import { scorePair } from '../scorer'
import { pickTonight, recordRollback, withOurEstimates, type SwitchCheck } from '../ourEstimates'
import { boroughFromLabel } from '../borough'
import { fromRaw } from '../../domain/Neighborhood'
import type { BuyerData, ListingData, ScoringContext } from '../scorerTypes'
import { IN_PLAY_BUYER_REQUEST, topForSeller, toMatchRow, type Candidate } from './select'
import { DELETE_STALE_MATCHES_SQL, EXISTING_MATCH_COUNTS_SQL, UPSERT_MATCHES_SQL } from './sql'
import { SCORING_REFUSED_ACTION, ScoringRefusedError, scoringRefusal, type ScoringRefusalDetails } from './guard'

// Brief 35: nightly-pipeline step 2. Scores every CRM seller (supply) against
// buyer demand with the Brief 32 scorer and keeps each seller's best pairs as
// Match rows. Writes only Match + AuditLog, in one transaction; a dry run
// executes the same statements, then rolls back.
// Brief 47 (PR 1): before any write, the size check (guard.ts, engineering
// precaution) can refuse the night. A refused night writes one AuditLog row,
// NIGHTLY_SCORING_REFUSED, and nothing else, then throws ScoringRefusedError
// (a refused dry run writes nothing and throws too).
export const ORG_SLUG = 'dealflow-ryan'
export const MAX_KEPT_PER_SELLER = 10 // guard: selection keeps ≤ 10 per seller, so more means a bug
const CHUNK = 1_000

export type ScoringResult = {
  dryRun: boolean
  includeTestBuyers: boolean
  sellers: number
  buyers: number
  demandExcludedNoLocation: number
  pairs: number
  eligible: number
  ineligibleByReason: Record<string, number>
  dismissed: number
  kept: number
  sellersCovered: number
  inserted: number
  updated: number
  deleted: number
  tiers: Record<string, number>
  confidence: Record<string, number>
  topUnknownFactors: Record<string, number>
  ms: number
  ourEstimates?: SwitchCheck // Brief 44 (PR 4): only on a night the USE_OUR_ESTIMATES switch is on
}

class DryRunRollback extends Error {
  constructor(readonly result: ScoringResult) { super('dry run: rolled back') }
}

// Brief 45 (PR E): `db` lets the import-scoring route's tests pass an
// in-memory stand-in; the nightly and the route use the real client.
export async function loadScoringInputs(
  orgId: string,
  db: Pick<PrismaClient, 'mojoContact' | 'extractedOpportunity' | 'matchDismissal' | 'featureFlag' | 'propertyValuation'> = prisma,
) {
  // Test buyers count as demand only when this is exactly 'true' (test-data phase).
  const demandScope = process.env.SCORING_INCLUDE_TEST_BUYERS === 'true' ? {} : { isTestData: false }
  const [sellers, mojoBuyers, isoBuyers, dismissals, comps] = await Promise.all([
    db.mojoContact.findMany({ where: { organizationId: orgId, isTestData: false, metadata: { path: ['source'], equals: 'crm' } } }),
    db.mojoContact.findMany({ where: { organizationId: orgId, intent: 'BUYER', ...demandScope } }),
    // Brief 48 (PR 10): buyer requests in play only (select.ts IN_PLAY_BUYER_REQUEST).
    db.extractedOpportunity.findMany({ where: { organizationId: orgId, category: 'BUYER_ISO', ...IN_PLAY_BUYER_REQUEST, ...demandScope } }),
    db.matchDismissal.findMany({ select: { partyId: true, listingId: true } }),
    precomputeCompsMedians(db, orgId),
  ])
  const listings = sellers.map(mojoContactToListingData)
  // A cold call needs a location match: buyers with no recognized neighborhood
  // and no borough are left out of nightly demand (isEligible is unchanged).
  const demand = [...isoBuyers.map(opportunityToBuyerData), ...mojoBuyers.map(mojoContactToBuyerData)]
  const buyers = demand.filter(b => b.neighborhoods.some(n => fromRaw(n) || boroughFromLabel(n)))
  const tagged = (rows: MojoContact[], tag: string) => new Set(rows.filter(r => r.tags.includes(tag)).map(r => r.id))
  const ctx: ScoringContext = {
    now: new Date(),
    compsMedians: comps.medians,
    substitutionCounts: precomputeSubstitutionCounts(buyers, listings),
    // Representation comes from existing tags only; this job never writes tags.
    ryanOwnedListingIds: tagged(sellers, 'ryan_listing'),
    ryanRepresentedBuyerIds: tagged(mojoBuyers, 'ryan_buyer'),
  }
  const dismissed = new Set(dismissals.map(d => `${d.partyId}|${d.listingId}`))
  // Brief 44 (PR 4): the USE_OUR_ESTIMATES switch, read once per run. Off: these inputs as
  // they are. On: CRM sellers priced by our published values (lib/matching/ourEstimates.ts).
  return withOurEstimates(db, orgId, { sellers, listings, buyers, ctx, dismissed, demandExcludedNoLocation: demand.length - buyers.length })
}

// Pure CPU: score every (seller, buyer) pair and keep each seller's top pairs.
export function scoreAll(listings: ListingData[], buyers: BuyerData[], ctx: ScoringContext, dismissed: Set<string>) {
  const stats = { pairs: 0, eligible: 0, dismissed: 0, ineligibleByReason: {} as Record<string, number> }
  const kept: Candidate[] = []
  for (const listing of listings) {
    const candidates: Candidate[] = []
    for (const buyer of buyers) {
      stats.pairs++
      const r = scorePair(listing, buyer, ctx)
      if (!r.eligibility.eligible) {
        const reason = r.eligibility.reason ?? 'unknown'
        stats.ineligibleByReason[reason] = (stats.ineligibleByReason[reason] ?? 0) + 1
        continue
      }
      stats.eligible++
      const key = resolveDismissKey({ opportunityId: listing.id, counterpartId: buyer.id, opportunityType: 'contact', opportunityCategory: null })
      if (dismissed.has(`${key.partyId}|${key.listingId}`)) { stats.dismissed++; continue }
      candidates.push({
        sellerId: listing.id, buyerId: buyer.id, counterpartType: buyer.sourceType === 'contact' ? 'mojo' : 'opportunity',
        matchFit: r.matchFit, captureStatus: r.captureStatus,
      })
    }
    kept.push(...topForSeller(candidates))
  }
  return { ...stats, kept }
}

const tally = (values: string[]) => values.reduce<Record<string, number>>((acc, v) => { acc[v] = (acc[v] ?? 0) + 1; return acc }, {})
const top = (counts: Record<string, number>, n: number) => Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n))

export async function runNightlyScoring({ dryRun = false } = {}): Promise<ScoringResult> {
  const started = Date.now()
  const org = await prisma.organization.findUniqueOrThrow({ where: { slug: ORG_SLUG }, select: { id: true } })
  const { listings, buyers, ctx, dismissed, demandExcludedNoLocation, ourEstimates } = await loadScoringInputs(org.id)
  // Brief 44 (PR 4): with the switch on, the night is also scored without our values, and
  // those results are kept if ours fail the rollback checks (lib/matching/ourEstimates.ts).
  const night = ourEstimates
    ? pickTonight(ourEstimates, () => scoreAll(listings, buyers, ctx, dismissed), () => scoreAll(ourEstimates.without.listings, buyers, ourEstimates.without.ctx, dismissed))
    : { result: scoreAll(listings, buyers, ctx, dismissed), check: undefined }
  const { kept, ...stats } = night.result
  if (kept.length > MAX_KEPT_PER_SELLER * listings.length) {
    throw new Error(`scoring kept ${kept.length} pairs for ${listings.length} sellers; aborting before any write`)
  }

  const rows = kept.map(c => ({ id: randomUUID(), ...toMatchRow(c) }))
  const keys = rows.map(r => ({ opportunityId: r.opportunityId, counterpartId: r.counterpartId, counterpartType: r.counterpartType }))
  const sellersCovered = new Set(rows.map(r => r.opportunityId)).size
  try {
    const out = await prisma.$transaction(async tx => {
      // Brief 47 (PR 1): the size check, counted in this transaction before the first
      // write. Refused: no Match row is written or deleted, the switch rollback isn't
      // recorded (the check runs again next night; its counts are in this row), and
      // there's no NIGHTLY_SCORING row.
      const [existing] = await tx.$queryRawUnsafe<{ matches: number; sellers: number }[]>(EXISTING_MATCH_COUNTS_SQL, org.id)
      const sizes = {
        sellers: listings.length, buyers: buyers.length, kept: rows.length, sellersCovered,
        existingMatches: existing.matches, existingSellersCovered: existing.sellers,
      }
      const reasons = scoringRefusal(sizes)
      if (reasons.length > 0) {
        const refused = new ScoringRefusedError(reasons)
        if (dryRun) throw refused // rolls the transaction back: a dry run writes nothing
        const details: ScoringRefusalDetails = {
          reasons, ...sizes, includeTestBuyers: process.env.SCORING_INCLUDE_TEST_BUYERS === 'true',
          ...(night.check && { ourEstimates: night.check }),
        }
        await tx.auditLog.create({ data: { organizationId: org.id, action: SCORING_REFUSED_ACTION, detailsJson: details } })
        return refused // the row commits with the transaction; thrown below
      }
      let inserted = 0
      let updated = 0
      for (let i = 0; i < rows.length; i += CHUNK) {
        const ret = await tx.$queryRawUnsafe<{ inserted: boolean }[]>(UPSERT_MATCHES_SQL, JSON.stringify(rows.slice(i, i + CHUNK)), org.id)
        inserted += ret.filter(r => r.inserted).length
        updated += ret.filter(r => !r.inserted).length
      }
      const deleted = await tx.$executeRawUnsafe(DELETE_STALE_MATCHES_SQL, org.id, JSON.stringify(keys))
      if (night.check?.rolledBack) await recordRollback(tx, org.id, night.check)
      const result: ScoringResult = {
        dryRun,
        includeTestBuyers: process.env.SCORING_INCLUDE_TEST_BUYERS === 'true',
        sellers: listings.length,
        buyers: buyers.length,
        demandExcludedNoLocation,
        ...stats,
        kept: rows.length,
        sellersCovered,
        inserted,
        updated,
        deleted,
        tiers: tally(rows.map(r => r.tier)),
        confidence: tally(rows.map(r => r.matchFitConfidence)),
        topUnknownFactors: top(tally(rows.flatMap(r => r.unknownFactors)), 5),
        ms: Date.now() - started,
        ...(night.check && { ourEstimates: night.check }),
      }
      if (dryRun) throw new DryRunRollback(result)
      await tx.auditLog.create({ data: { organizationId: org.id, action: 'NIGHTLY_SCORING', detailsJson: result } })
      return result
    }, { maxWait: 10_000, timeout: 120_000 })
    if (out instanceof ScoringRefusedError) throw out
    return out
  } catch (e) {
    if (e instanceof DryRunRollback) return e.result
    throw e
  }
}

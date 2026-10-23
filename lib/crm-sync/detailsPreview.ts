import type { MojoContact, PrismaClient } from '@prisma/client'
import type { CrmLeadRow } from './crmReader'
import type { Snapshot } from './crmWins'
import { DETAIL_COLUMNS, DETAIL_FIELDS, detailField, normName, sellerDetails, type DetailColumn } from './sellerDetails'
import { mojoContactToBuyerData, mojoContactToListingData, opportunityToBuyerData } from '../matching/adapters'
import { precomputeCompsMedians, precomputeSubstitutionCounts } from '../matching/compsCache'
import { boroughFromLabel } from '../matching/borough'
import { fromRaw } from '../domain/Neighborhood'
import type { ScoringContext } from '../matching/scorerTypes'

// Brief 48 (PR 9, item 4.10): the pure parts of scripts/brief48-crm-details-preview.ts,
// which shows, before or after this PR merges, which seller details the CRM holds and how
// copying them would change the call list's top 50. Counts and field labels only: no
// seller, value, phone number or address.

// $1 = the organization's slug. Every lead custom field the CRM has: its label (the
// upload's column header), type, and how many leads have a value. No values.
export const CRM_FIELDS_SQL = `
SELECT d.name, d.type, count(v.id)::int AS "leadsWithValue"
FROM "CustomFieldDefinition" d
JOIN "Organization" o ON o.id = d."organizationId" AND o.slug = $1
LEFT JOIN "CustomFieldValue" v ON v."definitionId" = d.id AND v."objectType" = 'lead'
WHERE d."objectType" = 'lead'
GROUP BY d.name, d.type ORDER BY d.name`

// $1 = the organization's slug. The CRM's phone types and verified line types, counted.
export const CRM_PHONE_TYPES_SQL = `
SELECT p.type, p."lineType", count(*)::int AS n
FROM "ContactPhone" p JOIN "Contact" c ON c.id = p."contactId"
JOIN "Organization" o ON o.id = c."organizationId" AND o.slug = $1
GROUP BY 1, 2 ORDER BY 1, 2`

export interface CrmField { name: string; type: string; leadsWithValue: number }

// Each CRM field with the DealFlow column the copy reads it into (null: not copied).
export function fieldInventory(fields: CrmField[]) {
  const column = (name: string) => DETAIL_COLUMNS.find(c => DETAIL_FIELDS[c].includes(normName(name))) ?? null
  return fields.map(f => ({ ...f, copiedTo: column(f.name) }))
}

// Per column: leads with one of its fields, and how many of those values weren't clear
// enough to copy (left blank).
export function detailCoverage(leads: Pick<CrmLeadRow, 'fields'>[]) {
  const out = Object.fromEntries(DETAIL_COLUMNS.map(c => [c, { leadsWithField: 0, unrecognized: 0 }])) as Record<DetailColumn, { leadsWithField: number; unrecognized: number }>
  for (const l of leads) {
    const details = sellerDetails(l.fields)
    for (const c of DETAIL_COLUMNS) {
      if (!detailField(l.fields, c)) continue
      out[c].leadsWithField++
      if (details[c] == null) out[c].unrecognized++
    }
  }
  return out
}

// A seller with the detail columns the copy would write (from a snapshot after-row):
// dates as Date (the snapshot has them as "YYYY-MM-DDTHH:MM:SS", UTC as Prisma reads them).
export function withDetails(seller: MojoContact, after: Snapshot): MojoContact {
  const out = { ...seller } as Record<string, unknown>
  for (const c of DETAIL_COLUMNS) {
    const v = after[c] ?? null
    out[c] = c === 'foreclosureAuctionDate' && typeof v === 'string' ? new Date(`${v}Z`) : c === 'tags' ? (v ?? seller.tags) : v
  }
  return out as unknown as MojoContact
}

// The six motivation factors that abstain without these columns (lib/matching/features).
const MOTIVATION: Array<keyof MojoContact> = ['preForeclosureStatus', 'foreclosureAuctionDate', 'isVacant', 'equityBalance', 'totalLoanBalance', 'loanInterestRate']
export const knownFactors = (s: Pick<MojoContact, 'preForeclosureStatus' | 'foreclosureAuctionDate' | 'isVacant' | 'equityBalance' | 'totalLoanBalance' | 'loanInterestRate'>) =>
  MOTIVATION.filter(k => (s as Record<string, unknown>)[k] != null).length

// How flat the top of a list is, and how many of its sellers have any motivation factor known.
export function topSummary(ranked: Array<{ contactId: string; priorityScore: number }>, factorsOf: (id: string) => number, n = 50) {
  const top = ranked.slice(0, n)
  return {
    distinctScores: new Set(top.map(r => r.priorityScore)).size,
    withAnyMotivationFactor: top.filter(r => factorsOf(r.contactId) > 0).length,
  }
}

// Tonight's scoring inputs as the nightly loads them (the loader in
// lib/matching/nightly/runScoring.ts), but never priced by DealFlow's own values: the
// USE_OUR_ESTIMATES switch is treated as off. Ryan's rule (2026-10-17) keeps our values out
// of anything a buyer or homeowner sees, and Brief 49 pins the files that read them
// (lib/valuations/__tests__/readers.unit.test.ts) [engineering precaution: this preview
// isn't one]. Both sides of the preview are scored this way, so the comparison isolates the
// seller details. detailsPreview.unit.test.ts checks this gives what the nightly's loader
// gives with the switch off.
export async function scoringInputsWithoutOurValues(
  db: Pick<PrismaClient, 'mojoContact' | 'extractedOpportunity' | 'matchDismissal'>,
  orgId: string,
) {
  const demandScope = process.env.SCORING_INCLUDE_TEST_BUYERS === 'true' ? {} : { isTestData: false }
  const [sellers, mojoBuyers, isoBuyers, dismissals, comps] = await Promise.all([
    db.mojoContact.findMany({ where: { organizationId: orgId, isTestData: false, metadata: { path: ['source'], equals: 'crm' } } }),
    db.mojoContact.findMany({ where: { organizationId: orgId, intent: 'BUYER', ...demandScope } }),
    db.extractedOpportunity.findMany({ where: { organizationId: orgId, category: 'BUYER_ISO', ...demandScope } }),
    db.matchDismissal.findMany({ select: { partyId: true, listingId: true } }),
    precomputeCompsMedians(db, orgId),
  ])
  const listings = sellers.map(mojoContactToListingData)
  const demand = [...isoBuyers.map(opportunityToBuyerData), ...mojoBuyers.map(mojoContactToBuyerData)]
  const buyers = demand.filter(b => b.neighborhoods.some(n => fromRaw(n) || boroughFromLabel(n)))
  const tagged = (rows: MojoContact[], tag: string) => new Set(rows.filter(r => r.tags.includes(tag)).map(r => r.id))
  const ctx: ScoringContext = {
    now: new Date(),
    compsMedians: comps.medians,
    substitutionCounts: precomputeSubstitutionCounts(buyers, listings),
    ryanOwnedListingIds: tagged(sellers, 'ryan_listing'),
    ryanRepresentedBuyerIds: tagged(mojoBuyers, 'ryan_buyer'),
  }
  const dismissed = new Set(dismissals.map(d => `${d.partyId}|${d.listingId}`))
  return { sellers, listings, buyers, ctx, dismissed, demandExcludedNoLocation: demand.length - buyers.length }
}

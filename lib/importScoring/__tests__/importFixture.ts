// Brief 45 (PR E): a made-up CRM upload and a made-up DealFlow world for the
// import-scoring tests, plus an in-memory version of each SQL statement the
// path runs (memoryDb hands raw SQL to `importRaw`). Fictional names, streets
// and 555-01xx phones only. Not a *.test.ts file.
import { createHash } from 'crypto'
import type { CrmLeadRow } from '../../crm-sync/crmReader'
import { COLUMNS, DUPLICATES_SQL, REKEY_SQL, UPSERT_SQL } from '../../crm-sync/upsert'
import { EXISTING_SQL, MARKED_CRM_SQL } from '../../crm-sync/runSync'
import { DELETE_STALE_MATCHES_OF_SELLERS_SQL, UPSERT_MATCHES_SQL } from '../../matching/nightly/sql'
import { IMPORT_BATCH_SQL, NEW_IMPORT_LEADS_SQL } from '../crmRead'
import { SIGNALS_SQL } from '../signals'
import { memoryDb, type Row } from '../../__tests__/memoryDb'

export const NOW = new Date('2026-10-18T19:00:00.000Z')
export const TOKEN = 'A'.repeat(20) + '_-' + 'b'.repeat(21) // 43 base64url characters
export const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex')
export const IMPORT_ID = 'imp_b45_1'
export const DF_ORG = 'org_df'

// ── The CRM side ─────────────────────────────────────────────────────────────

const field = (t: string | null, n: number | null = null) => ({ t, n, d: null })
export function crmLead(id: string, mojoId: string, street: string, over: Partial<CrmLeadRow> = {}, zip = '11216'): CrmLeadRow {
  return {
    id, mojoId, name: `Test Owner ${id}`, displayName: `Test Owner ${id}`,
    primaryAddressFull: `${street}, Brooklyn, NY ${zip}`, updatedAt: '2026-10-18 18:40:00',
    contactName: null, phones: ['+17185550150'], emails: [],
    fields: {
      'Property City': field('Brooklyn'), 'Property State': field('NY'), 'Property Zip Code': field(zip),
      'Property Type': field('Duplex'), Bedrooms: field(null, 6), Bathrooms: field(null, 2),
      'Last Call Result': field('New lead'),
    },
    ...over,
  }
}

// The upload: four new people (one without a Mojo ID), one existing lead the
// upload merged into (not new), one new lead whose name and street match both
// another CRM lead and an old DealFlow csv copy (ambiguous: never copied).
export const LEADS = {
  new1: crmLead('lead_new1', '7700001', '101 Example St'),
  new2: crmLead('lead_new2', '7700002', '102 Example St'),
  far: crmLead('lead_far', '7700003', '103 Example Ave', {}, '10301'), // Staten Island: no buyer wants it
  noMojo: 'lead_nomojo',
  old: crmLead('lead_old', '7700010', '110 Example St'),
  amb: crmLead('lead_amb', '7700005', '300 Example St', { name: 'Test Owner Twin' }),
  // Not in the request: the nightly would copy or re-key these; the import path must not.
  ambTwin: crmLead('lead_ambtwin', '7700006', '300 Example St', { name: 'Test Owner Twin' }),
  other: crmLead('lead_other', '7700007', '107 Example St'),
  rekeyOther: crmLead('lead_rekey', '7700008', '108 Example St', { name: 'Test Owner Rekey' }),
}
export const REQUEST_IDS = ['lead_new1', 'lead_new2', 'lead_far', 'lead_nomojo', 'lead_old', 'lead_amb', 'lead_unknown']

export function crmWorld(over: { batch?: Row | null } = {}) {
  const batch: Row | null = over.batch === undefined
    ? { orgSlug: 'dealflow-ryan', status: 'completed', completedAt: new Date(NOW.getTime() - 10 * 60_000), tokenHash: TOKEN_HASH, scoredAt: null }
    : over.batch
  const fullRead = [LEADS.new1, LEADS.new2, LEADS.far, LEADS.old, LEADS.amb, LEADS.ambTwin, LEADS.other, LEADS.rekeyOther]
  // What NEW_IMPORT_LEADS_SQL returns: the upload's new people (source + createdAt rule).
  const newInImport = [
    { id: 'lead_new1', mojoId: '7700001' }, { id: 'lead_new2', mojoId: '7700002' }, { id: 'lead_far', mojoId: '7700003' },
    { id: 'lead_nomojo', mojoId: null }, { id: 'lead_amb', mojoId: '7700005' },
  ]
  const calls: { sql: string; params: unknown[] }[] = []
  const crmQuery = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params })
    if (sql === IMPORT_BATCH_SQL) return (batch ? [batch] : []) as T[]
    if (sql === NEW_IMPORT_LEADS_SQL) return newInImport.filter(l => (params[1] as string[]).includes(l.id)) as T[]
    throw new Error(`unexpected CRM query: ${sql.slice(0, 60)}`)
  }
  const readCrmLeads = async (slug: string) => {
    calls.push({ sql: 'readCrmLeads', params: [slug] })
    return fullRead
  }
  return { crmQuery, readCrmLeads, calls }
}

// ── The DealFlow side ────────────────────────────────────────────────────────

export function mojoContact(id: string, mojoId: string, over: Row = {}): Row {
  const base: Row = {
    id, mojoId, organizationId: DF_ORG, fullName: `Test Owner ${id}`, phone: '7185550160', email: null, address: null,
    city: null, state: null, zipCode: null, neighborhood: null, status: null, tags: [], notes: null, mojoGroup: null,
    mojoList: null, groups: [], isTestData: false, intent: 'SELLER', bedsMin: null, bedsMax: null, budgetMin: null,
    budgetMax: null, cashOnly: null, timing: null, initialNeighborhood: null, metadata: { source: 'crm' }, lastCalled: null,
    lastDialDate: null, estimatedValue: null, equityBalance: null, currentLTV: null, totalLoanBalance: null,
    loanInterestRate: null, propertyBeds: null, propertyBaths: null, preForeclosureStatus: null, foreclosureAuctionDate: null,
    isVacant: null, ownerOccupied: null, alternateAddress: null, coOwnerFullName: null, lastSaleDate: null, lastSalePrice: null,
    yearBuilt: null, unitCount: null, buildingSqft: null, lotSizeSqft: null, zoningCode: null, propertyTypeDetail: null,
    priorListingStatus: null, priorListingDom: null, priorListingBrokerage: null, priorListingPrice: null,
    additionalPhones: [], additionalEmails: [], phoneDncFlags: [false], phoneTypes: ['mobile'], batchRankCategory: null,
    createdAt: new Date('2026-09-01T12:00:00Z'), updatedAt: new Date('2026-09-01T12:00:00Z'),
  }
  return { ...base, ...over }
}

function buyerIso(id: string, over: Row = {}): Row {
  return {
    id, organizationId: DF_ORG, category: 'BUYER_ISO', transactionType: 'BUYER_NEED', isTestData: false,
    neighborhood: null, neighborhoods: ['Crown Heights'], propertyTypes: ['Multi-Family'], minBeds: 2, maxBeds: 4, beds: null,
    bathsMin: null, bathsMax: null, minPrice: null, maxPrice: null, price: null, mustHaves: null, dealbreakers: null,
    buyerArchetype: 'CASH_BUYER', timeline: null, sourceAgentName: `Test Agent ${id}`, sourceBrokerage: 'Example Realty',
    sourceAgentEmail: 'agent@example.com', monthlyMaintenance: null, monthlyCommonCharges: null, monthlyTaxes: null,
    createdAt: new Date('2026-10-01T12:00:00Z'), ...over,
  }
}

export function dealflowWorld() {
  return {
    organization: [{ id: DF_ORG, slug: 'dealflow-ryan' }],
    mojoContact: [
      // Sellers already in DealFlow (the nightly owns their matches).
      mojoContact('s_old1', '7700100', { neighborhood: 'Crown Heights', zipCode: '11216', propertyTypeDetail: 'Duplex', unitCount: 2, propertyBeds: 6 }),
      mojoContact('s_old2', '7700101', { neighborhood: 'Crown Heights', zipCode: '11216' }),
      // A lead copied on an earlier try: blanks get filled, values are kept.
      mojoContact('s_new1', '7700001', { status: 'Earlier status', metadata: { source: 'crm', crmLeadId: 'lead_new1' } }),
      // Old csv copies: one twin of the ambiguous pair, one the nightly would re-key.
      mojoContact('csv_amb', 'csv_900', { fullName: 'Test Owner Twin', address: '300 Example St', state: 'NY', zipCode: '11216', metadata: null }),
      mojoContact('csv_rekey', 'csv_901', { fullName: 'Test Owner Rekey', address: '108 Example St', state: 'NY', zipCode: '11216', metadata: null }),
      // A Mojo buyer contact (demand side).
      mojoContact('b_mojo', '7700200', { intent: 'BUYER', metadata: { source: 'crm' }, neighborhood: 'Crown Heights', bedsMin: 2, bedsMax: 4 }),
      // A test seller: never scored, never ranked.
      mojoContact('s_test', '7700300', { isTestData: true, neighborhood: 'Crown Heights' }),
    ],
    extractedOpportunity: [1, 2, 3, 4, 5, 6, 7].map(i => buyerIso(`b_iso${i}`, { minPrice: 900_000 + i * 50_000, maxPrice: 2_500_000 })),
    match: [
      // s_old1's rows (not kept by this run: the nightly would delete them, the import path must not).
      { id: 'm_old1', organizationId: DF_ORG, opportunityId: 's_old1', opportunityType: 'contact', counterpartId: 'b_iso1', counterpartType: 'opportunity',
        score: 70, tier: 'WARM', reason: 'old', captureStatus: 'EXTERNAL_BOTH', matchFitConfidence: 'HIGH', contributions: {}, unknownFactors: [], createdAt: new Date('2026-10-10T09:00:00Z') },
      // s_new1's stale row from the earlier try (that buyer is gone): deleted.
      { id: 'm_stale_new1', organizationId: DF_ORG, opportunityId: 's_new1', opportunityType: 'contact', counterpartId: 'b_gone', counterpartType: 'opportunity',
        score: 60, tier: 'POSSIBLE', reason: 'old', captureStatus: 'EXTERNAL_BOTH', matchFitConfidence: 'LOW', contributions: {}, unknownFactors: [], createdAt: new Date('2026-10-18T18:00:00Z') },
    ],
    matchDismissal: [{ partyId: 'b_iso7', listingId: 's_new1' }],
    auditLog: [],
    callQueueEntry: [],
  }
}

// ── In-memory versions of the SQL the path runs ─────────────────────────────
// Each mirrors its statement closely enough for these tests; the real SQL runs
// against Postgres in scoreImport.integration.test.ts.

const UPDATED = COLUMNS.filter(([, , mode]) => mode !== 'insert')
const blank = (v: unknown) => v == null || (Array.isArray(v) && v.length === 0)

function upsertLeads(data: Record<string, Row[]>, rows: Row[], orgId: string) {
  const out: Row[] = []
  for (const r of rows) {
    const old = data.mojoContact.find(m => m.mojoId === r.mojoId)
    if (!old) {
      data.mojoContact.push({ ...mojoContact(r.id as string, r.mojoId as string), ...r, organizationId: orgId, intent: 'SELLER', isTestData: false })
      out.push({ mojoId: r.mojoId, inserted: true, before: {}, after: {} })
      continue
    }
    if (old.isTestData || old.organizationId !== orgId) continue
    const before = Object.fromEntries(UPDATED.map(([c]) => [c, old[c]]))
    for (const [c, , mode] of UPDATED) {
      if (mode === 'merge') old[c] = { ...((old[c] as Row) ?? {}), ...(r[c] as Row) }
      else if (mode === 'append') {
        const o = (old[c] as unknown[]) ?? []
        const n = (r[c] as unknown[]) ?? []
        if (JSON.stringify(o) === JSON.stringify(n.slice(0, o.length))) old[c] = n
      } else if (blank(old[c])) old[c] = r[c] ?? null
    }
    const after = Object.fromEntries(UPDATED.map(([c]) => [c, old[c]]))
    if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ mojoId: r.mojoId, inserted: false, before, after })
  }
  return out
}

function upsertMatches(data: Record<string, Row[]>, rows: Row[], orgId: string) {
  return rows.map(r => {
    const old = data.match.find(m => m.opportunityId === r.opportunityId && m.counterpartId === r.counterpartId && m.counterpartType === r.counterpartType)
    if (old) { Object.assign(old, { score: r.score, tier: r.tier, reason: r.reason, captureStatus: r.captureStatus, matchFitConfidence: r.matchFitConfidence, contributions: r.contributions, unknownFactors: r.unknownFactors }); return { inserted: false } }
    data.match.push({ ...r, organizationId: orgId, opportunityType: 'contact', seen: false, createdAt: new Date() })
    return { inserted: true }
  })
}

// SIGNALS_SQL: the primary match's columns and up to 5 buyers (primary, then
// contributing, kept in that order, then sorted by score), as BUYERS_SQL does.
function signals(data: Record<string, Row[]>, entries: Row[]) {
  return entries.map(e => {
    const byId = (id: unknown) => data.match.find(m => m.id === id)
    const primary = byId(e.primaryMatchId)
    const ids = [e.primaryMatchId, ...(e.contributingMatchIds as string[])].slice(0, 5)
    const buyers = ids.map((id, i) => ({ m: byId(id), ord: i + 1 })).filter(x => x.m).map(({ m, ord }) => {
      const eo = m!.counterpartType === 'opportunity' ? data.extractedOpportunity.find(o => o.id === m!.counterpartId) : undefined
      const bc = m!.counterpartType === 'mojo' ? data.mojoContact.find(c => c.id === m!.counterpartId) : undefined
      return {
        ord, matchId: m!.id, score: m!.score, tier: m!.tier, reasonKeys: String(m!.reason ?? '').split(' + '), captureStatus: m!.captureStatus,
        type: m!.counterpartType, name: eo?.sourceAgentName ?? bc?.fullName ?? null, brokerage: eo?.sourceBrokerage ?? null,
        neighborhoods: (eo?.neighborhoods as string[] | undefined)?.length ? eo!.neighborhoods : [eo?.neighborhood ?? bc?.neighborhood ?? bc?.initialNeighborhood].filter(Boolean),
        propertyTypes: eo?.propertyTypes ?? [], bedsMin: eo?.minBeds ?? eo?.beds ?? bc?.bedsMin ?? null, bedsMax: eo?.maxBeds ?? eo?.beds ?? bc?.bedsMax ?? null,
        priceMin: eo?.minPrice ?? eo?.price ?? bc?.budgetMin ?? null, priceMax: eo?.maxPrice ?? eo?.price ?? bc?.budgetMax ?? null,
        buyerArchetype: eo?.buyerArchetype ?? (bc?.cashOnly ? 'CASH_BUYER' : null), isTestData: eo?.isTestData ?? bc?.isTestData ?? false,
      }
    }).sort((a, b) => (b.score as number) - (a.score as number) || a.ord - b.ord).map(({ ord: _ord, ...b }) => b)
    return {
      contactId: e.contactId, primary_match_fit: primary?.score ?? null, primary_capture_status: primary?.captureStatus ?? null,
      primary_match_confidence: primary?.matchFitConfidence ?? null, match_reason: primary?.reason ?? null, buyers,
    }
  })
}

export function importRaw(data: Record<string, Row[]>) {
  return (sql: string, params: unknown[]): unknown => {
    const json = (i: number) => JSON.parse(params[i] as string) as Row[]
    if (sql === MARKED_CRM_SQL) return [{ n: data.mojoContact.filter(m => m.organizationId === params[0] && (m.metadata as Row | null)?.source === 'crm').length }]
    if (sql === EXISTING_SQL) return data.mojoContact.filter(m => m.organizationId === params[0] && !m.isTestData)
    if (sql === REKEY_SQL) {
      let n = 0
      for (const k of json(0)) { const m = data.mojoContact.find(c => c.id === k.id && c.mojoId === k.old_id && !c.isTestData); if (m) { m.mojoId = k.new_id; n++ } }
      return n
    }
    if (sql === UPSERT_SQL) return upsertLeads(data, json(0), params[1] as string)
    if (sql === DUPLICATES_SQL) return json(0).length
    if (sql === UPSERT_MATCHES_SQL) return upsertMatches(data, json(0), params[1] as string)
    if (sql === DELETE_STALE_MATCHES_OF_SELLERS_SQL) {
      const kept = new Set(json(1).map(k => `${k.opportunityId}|${k.counterpartId}|${k.counterpartType}`))
      const sellers = new Set(JSON.parse(params[2] as string) as string[])
      const before = data.match.length
      data.match = data.match.filter(m => !(m.organizationId === params[0] && m.opportunityType === 'contact' && sellers.has(m.opportunityId as string) &&
        data.mojoContact.some(c => c.id === m.opportunityId && !c.isTestData) && !kept.has(`${m.opportunityId}|${m.counterpartId}|${m.counterpartType}`)))
      return before - data.match.length
    }
    if (sql === SIGNALS_SQL) return signals(data, json(0))
    throw new Error(`unexpected SQL: ${sql.replace(/\s+/g, ' ').slice(0, 80)}`)
  }
}

export function dealflowDb() {
  return memoryDb(dealflowWorld(), (sql, params, _kind, data) => importRaw(data as unknown as Record<string, Row[]>)(sql, params))
}
